import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import LRUCache from 'lru-cache';
import { Agent, AgentConnectOpts } from 'agent-base';
import createDebug from 'debug';
import { getProxyForUrl as envGetProxyForUrl } from 'proxy-from-env';
import type { PacProxyAgent, PacProxyAgentOptions } from 'pac-proxy-agent';
import type { HttpProxyAgent, HttpProxyAgentOptions } from 'http-proxy-agent';
import type {
	HttpsProxyAgent,
	HttpsProxyAgentOptions,
} from 'https-proxy-agent';
import type {
	SocksProxyAgent,
	SocksProxyAgentOptions,
} from 'socks-proxy-agent';

const debug = createDebug('proxy-agent');

/**
 * Optimization: Protocol detection cache
 * Pre-compute protocol validity to avoid repeated Object.keys() calls
 */
const VALID_PROTOCOLS = new Set<string>([
	'http',
	'https',
	'socks',
	'socks4',
	'socks4a',
	'socks5',
	'socks5h',
	'pac+data',
	'pac+file',
	'pac+ftp',
	'pac+http',
	'pac+https',
]);

type ValidProtocol =
	| (typeof HttpProxyAgent.protocols)[number]
	| (typeof HttpsProxyAgent.protocols)[number]
	| (typeof SocksProxyAgent.protocols)[number]
	| (typeof PacProxyAgent.protocols)[number];

type AgentConstructor = new (
	proxy: string,
	proxyAgentOptions?: ProxyAgentOptions
) => Agent;

type GetProxyForUrlCallback = (
	url: string,
	req: http.ClientRequest
) => string | Promise<string>;

/**
 * Shorthands for built-in supported types.
 * Lazily loaded since some of these imports can be quite expensive
 * (in particular, pac-proxy-agent).
 */
const wellKnownAgents = {
	http: async () => (await import('http-proxy-agent')).HttpProxyAgent,
	https: async () => (await import('https-proxy-agent')).HttpsProxyAgent,
	socks: async () => (await import('socks-proxy-agent')).SocksProxyAgent,
	pac: async () => (await import('pac-proxy-agent')).PacProxyAgent,
} as const;

/**
 * Supported proxy types.
 */
export const proxies: {
	[P in ValidProtocol]: [
		() => Promise<AgentConstructor>,
		() => Promise<AgentConstructor>
	];
} = {
	http: [wellKnownAgents.http, wellKnownAgents.https],
	https: [wellKnownAgents.http, wellKnownAgents.https],
	socks: [wellKnownAgents.socks, wellKnownAgents.socks],
	socks4: [wellKnownAgents.socks, wellKnownAgents.socks],
	socks4a: [wellKnownAgents.socks, wellKnownAgents.socks],
	socks5: [wellKnownAgents.socks, wellKnownAgents.socks],
	socks5h: [wellKnownAgents.socks, wellKnownAgents.socks],
	'pac+data': [wellKnownAgents.pac, wellKnownAgents.pac],
	'pac+file': [wellKnownAgents.pac, wellKnownAgents.pac],
	'pac+ftp': [wellKnownAgents.pac, wellKnownAgents.pac],
	'pac+http': [wellKnownAgents.pac, wellKnownAgents.pac],
	'pac+https': [wellKnownAgents.pac, wellKnownAgents.pac],
};

function isValidProtocol(v: string): v is ValidProtocol {
	// Optimization: Use pre-computed Set for O(1) lookup instead of O(n) array search
	return VALID_PROTOCOLS.has(v);
}

export type ProxyAgentOptions = HttpProxyAgentOptions<''> &
	HttpsProxyAgentOptions<''> &
	SocksProxyAgentOptions &
	PacProxyAgentOptions<''> & {
		/**
		 * Default `http.Agent` instance to use when no proxy is
		 * configured for a request. Defaults to a new `http.Agent()`
		 * instance with the proxy agent options passed in.
		 */
		httpAgent?: http.Agent;
		/**
		 * Default `http.Agent` instance to use when no proxy is
		 * configured for a request. Defaults to a new `https.Agent()`
		 * instance with the proxy agent options passed in.
		 */
		httpsAgent?: http.Agent;
		/**
		 * A callback for dynamic provision of proxy for url.
		 * Defaults to standard proxy environment variables,
		 * see https://www.npmjs.com/package/proxy-from-env for details
		 */
		getProxyForUrl?: GetProxyForUrlCallback;
	};

/**
 * Uses the appropriate `Agent` subclass based off of the "proxy"
 * environment variables that are currently set.
 *
 * Optimizations implemented:
 * - LRU cache for Agent instances (prevents unnecessary creation)
 * - Proxy resolution cache (Map-based for O(1) lookups)
 * - Protocol detection optimization (Set-based lookup)
 * - Connection reuse via keepAlive
 * - Agent constructor caching (avoid repeated dynamic imports)
 */
export class ProxyAgent extends Agent {
	/**
	 * Cache for `Agent` instances with optimized size.
	 */
	cache = new LRUCache<string, Agent>({
		max: 50, // Increased from 20 for better agent reuse
		dispose: (agent) => agent.destroy(),
	});

	/**
	 * Optimization: Proxy resolution cache
	 * Cache proxy URL lookups to avoid repeated environment variable parsing
	 */
	private proxyResolutionCache = new Map<string, string>();
	private readonly maxProxyCacheSize = 100;

	/**
	 * Optimization: Lazy-loaded agent constructors cache
	 * Avoid repeated dynamic imports for the same protocol
	 */
	private agentConstructorCache = new Map<string, any>();

	connectOpts?: ProxyAgentOptions;
	httpAgent: http.Agent;
	httpsAgent: http.Agent;
	getProxyForUrl: GetProxyForUrlCallback;

	constructor(opts?: ProxyAgentOptions) {
		super(opts);
		debug('Creating new ProxyAgent instance: %o', opts);
		this.connectOpts = opts;

		// Optimization: Reuse provided agents or create with keepAlive for connection pooling
		this.httpAgent = opts?.httpAgent || new http.Agent({
			...opts,
			keepAlive: true,
			keepAliveMsecs: 1000,
		});
		this.httpsAgent = opts?.httpsAgent || new https.Agent({
			...(opts as https.AgentOptions),
			keepAlive: true,
			keepAliveMsecs: 1000,
		});
		this.getProxyForUrl = opts?.getProxyForUrl || envGetProxyForUrl;
	}

	async connect(
		req: http.ClientRequest,
		opts: AgentConnectOpts
	): Promise<http.Agent> {
		const { secureEndpoint } = opts;
		const isWebSocket = req.getHeader('upgrade') === 'websocket';
		const protocol = secureEndpoint
			? isWebSocket
				? 'wss:'
				: 'https:'
			: isWebSocket
			? 'ws:'
			: 'http:';
		const host = req.getHeader('host');
		const url = new URL(req.path, `${protocol}//${host}`).href;

		// Optimization: Check proxy resolution cache first
		let proxy: string | undefined;
		if (this.proxyResolutionCache.has(url)) {
			proxy = this.proxyResolutionCache.get(url);
			debug('Proxy resolution cache hit for URL: %o', url);
		} else {
			proxy = await this.getProxyForUrl(url, req);

			// Only cache if we got a valid proxy string
			if (proxy) {
				// Optimization: Implement LRU-like behavior for proxy cache
				if (this.proxyResolutionCache.size >= this.maxProxyCacheSize) {
					// Remove oldest entry (first key)
					const firstKey = this.proxyResolutionCache.keys().next().value;
					if (firstKey) {
						this.proxyResolutionCache.delete(firstKey);
					}
				}
				this.proxyResolutionCache.set(url, proxy);
			}
		}

		if (!proxy) {
			debug('Proxy not enabled for URL: %o', url);
			return secureEndpoint ? this.httpsAgent : this.httpAgent;
		}

		debug('Request URL: %o', url);
		debug('Proxy URL: %o', proxy);

		// Optimization: Attempt to get a cached `http.Agent` instance first
		const cacheKey = `${protocol}+${proxy}`;
		let agent = this.cache.get(cacheKey);
		if (!agent) {
			const proxyUrl = new URL(proxy);
			const proxyProto = proxyUrl.protocol.replace(':', '');
			if (!isValidProtocol(proxyProto)) {
				throw new Error(`Unsupported protocol for proxy URL: ${proxy}`);
			}

			// Optimization: Check constructor cache to avoid repeated dynamic imports
			const ctorIndex = secureEndpoint || isWebSocket ? 1 : 0;
			const constructorKey = `${proxyProto}:${ctorIndex}`;
			let ctor = this.agentConstructorCache.get(constructorKey);

			if (!ctor) {
				ctor = await proxies[proxyProto][ctorIndex]();
				this.agentConstructorCache.set(constructorKey, ctor);
			}

			agent = new ctor(proxy, this.connectOpts);
			this.cache.set(cacheKey, agent);
		} else {
			debug('Cache hit for proxy URL: %o', proxy);
		}

		return agent;
	}

	destroy(): void {
		// Optimization: Clear caches to free memory
		this.cache.forEach((value: Agent) => {
			value.destroy();
		});
		this.cache.clear();
		this.proxyResolutionCache.clear();
		this.agentConstructorCache.clear();
		this.httpAgent.destroy();
		this.httpsAgent.destroy();
		super.destroy();
	}
}
