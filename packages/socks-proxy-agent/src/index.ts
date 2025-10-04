import { SocksClient, SocksProxy, SocksClientOptions } from 'socks';
import { Agent, AgentConnectOpts } from 'agent-base';
import createDebug from 'debug';
import * as dns from 'dns';
import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import { URL } from 'url';

const debug = createDebug('socks-proxy-agent');

// Agent pooling for reusing instances
const agentPool = new Map<string, SocksProxyAgent>();
const MAX_POOL_SIZE = 100;

// DNS lookup cache with TTL
interface DNSCacheEntry {
	address: string;
	timestamp: number;
}
const dnsCache = new Map<string, DNSCacheEntry>();
const DNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Socket cache for connection reuse
interface SocketCacheEntry {
	socket: net.Socket;
	lastUsed: number;
	inUse: boolean;
}
const socketCache = new Map<string, SocketCacheEntry[]>();
const MAX_SOCKETS_PER_HOST = 10;
const SOCKET_IDLE_TIMEOUT = 30000; // 30 seconds

// Auth state cache
interface AuthCacheEntry {
	authenticated: boolean;
	timestamp: number;
}
const authCache = new Map<string, AuthCacheEntry>();
const AUTH_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Helper: Clean expired DNS cache entries
function cleanDNSCache(): void {
	const now = Date.now();
	for (const [key, entry] of dnsCache.entries()) {
		if (now - entry.timestamp > DNS_CACHE_TTL) {
			dnsCache.delete(key);
		}
	}
}

// Helper: Clean expired auth cache entries
function cleanAuthCache(): void {
	const now = Date.now();
	for (const [key, entry] of authCache.entries()) {
		if (now - entry.timestamp > AUTH_CACHE_TTL) {
			authCache.delete(key);
		}
	}
}

// Helper: Clean idle sockets from cache
function cleanSocketCache(): void {
	const now = Date.now();
	for (const [key, entries] of socketCache.entries()) {
		const filtered = entries.filter((entry) => {
			if (!entry.inUse && now - entry.lastUsed > SOCKET_IDLE_TIMEOUT) {
				entry.socket.destroy();
				return false;
			}
			return true;
		});
		if (filtered.length === 0) {
			socketCache.delete(key);
		} else {
			socketCache.set(key, filtered);
		}
	}
}

// Run periodic cleanup
setInterval(() => {
	cleanDNSCache();
	cleanAuthCache();
	cleanSocketCache();
}, 60000); // Every minute

// Helper: Get cached socket or null
function getCachedSocket(cacheKey: string): net.Socket | null {
	const entries = socketCache.get(cacheKey);
	if (!entries || entries.length === 0) return null;

	const available = entries.find((e) => !e.inUse && !e.socket.destroyed);
	if (available) {
		available.inUse = true;
		available.lastUsed = Date.now();
		debug('Reusing cached socket for %s', cacheKey);
		return available.socket;
	}
	return null;
}

// Helper: Cache a socket for reuse
function cacheSocket(cacheKey: string, socket: net.Socket): void {
	let entries = socketCache.get(cacheKey);
	if (!entries) {
		entries = [];
		socketCache.set(cacheKey, entries);
	}

	// Limit sockets per host
	if (entries.length >= MAX_SOCKETS_PER_HOST) {
		const oldest = entries.shift();
		if (oldest && !oldest.inUse) {
			oldest.socket.destroy();
		}
	}

	entries.push({
		socket,
		lastUsed: Date.now(),
		inUse: false,
	});

	// Enable keep-alive on the socket
	socket.setKeepAlive(true, 1000);
	socket.setNoDelay(true);

	// Mark socket as available when it becomes idle
	socket.once('close', () => {
		const currentEntries = socketCache.get(cacheKey);
		if (currentEntries) {
			const idx = currentEntries.findIndex((e) => e.socket === socket);
			if (idx !== -1) currentEntries.splice(idx, 1);
		}
	});
}

// Helper: Release cached socket back to pool
function releaseSocket(cacheKey: string, socket: net.Socket): void {
	const entries = socketCache.get(cacheKey);
	if (entries) {
		const entry = entries.find((e) => e.socket === socket);
		if (entry) {
			entry.inUse = false;
			entry.lastUsed = Date.now();
		}
	}
}

const setServernameFromNonIpHost = <
	T extends { host?: string; servername?: string }
>(
	options: T
) => {
	if (
		options.servername === undefined &&
		options.host &&
		!net.isIP(options.host)
	) {
		return {
			...options,
			servername: options.host,
		};
	}
	return options;
};

function parseSocksURL(url: URL): { lookup: boolean; proxy: SocksProxy } {
	let lookup = false;
	let type: SocksProxy['type'] = 5;
	const host = url.hostname;

	// From RFC 1928, Section 3: https://tools.ietf.org/html/rfc1928#section-3
	// "The SOCKS service is conventionally located on TCP port 1080"
	const port = parseInt(url.port, 10) || 1080;

	// figure out if we want socks v4 or v5, based on the "protocol" used.
	// Defaults to 5.
	switch (url.protocol.replace(':', '')) {
		case 'socks4':
			lookup = true;
			type = 4;
			break;
		// pass through
		case 'socks4a':
			type = 4;
			break;
		case 'socks5':
			lookup = true;
			type = 5;
			break;
		// pass through
		case 'socks': // no version specified, default to 5h
			type = 5;
			break;
		case 'socks5h':
			type = 5;
			break;
		default:
			throw new TypeError(
				`A "socks" protocol must be specified! Got: ${String(
					url.protocol
				)}`
			);
	}

	const proxy: SocksProxy = {
		host,
		port,
		type,
	};

	if (url.username) {
		Object.defineProperty(proxy, 'userId', {
			value: decodeURIComponent(url.username),
			enumerable: false,
		});
	}

	if (url.password != null) {
		Object.defineProperty(proxy, 'password', {
			value: decodeURIComponent(url.password),
			enumerable: false,
		});
	}

	return { lookup, proxy };
}

type SocksSocketOptions = Omit<net.TcpNetConnectOpts, 'port' | 'host'>;

export type SocksProxyAgentOptions = Omit<
	SocksProxy,
	// These come from the parsed URL
	'ipaddress' | 'host' | 'port' | 'type' | 'userId' | 'password'
> & {
	socketOptions?: SocksSocketOptions;
	enablePooling?: boolean;
	enableDNSCache?: boolean;
	enableSocketCache?: boolean;
	enableAuthCache?: boolean;
} & http.AgentOptions;

export class SocksProxyAgent extends Agent {
	static protocols = [
		'socks',
		'socks4',
		'socks4a',
		'socks5',
		'socks5h',
	] as const;

	readonly shouldLookup: boolean;
	readonly proxy: SocksProxy;
	timeout: number | null;
	socketOptions: SocksSocketOptions | null;
	enablePooling: boolean;
	enableDNSCache: boolean;
	enableSocketCache: boolean;
	enableAuthCache: boolean;
	private poolKey: string;

	constructor(uri: string | URL, opts?: SocksProxyAgentOptions) {
		// Enable keep-alive by default for connection reuse
		const agentOpts = {
			keepAlive: true,
			keepAliveMsecs: 1000,
			...opts,
		};
		super(agentOpts);

		const url = typeof uri === 'string' ? new URL(uri) : uri;
		const { proxy, lookup } = parseSocksURL(url);

		this.shouldLookup = lookup;
		this.proxy = proxy;
		this.timeout = opts?.timeout ?? null;
		this.socketOptions = opts?.socketOptions ?? null;

		// Enable optimizations by default (socket caching disabled by default for SOCKS)
		this.enablePooling = opts?.enablePooling !== false;
		this.enableDNSCache = opts?.enableDNSCache !== false;
		this.enableSocketCache = opts?.enableSocketCache === true; // Opt-in for socket caching
		this.enableAuthCache = opts?.enableAuthCache !== false;

		// Generate pool key for agent pooling
		this.poolKey = `${proxy.host}:${proxy.port}:${proxy.type}`;
	}

	// Static method for agent pooling
	static getAgent(uri: string | URL, opts?: SocksProxyAgentOptions): SocksProxyAgent {
		const url = typeof uri === 'string' ? new URL(uri) : uri;
		const { proxy } = parseSocksURL(url);
		const poolKey = `${proxy.host}:${proxy.port}:${proxy.type}`;

		// Return pooled agent if pooling is enabled
		if (opts?.enablePooling !== false) {
			let agent = agentPool.get(poolKey);
			if (!agent) {
				agent = new SocksProxyAgent(uri, opts);

				// Limit pool size
				if (agentPool.size >= MAX_POOL_SIZE) {
					const firstKey = agentPool.keys().next().value;
					agentPool.delete(firstKey);
				}

				agentPool.set(poolKey, agent);
				debug('Created new pooled agent for %s', poolKey);
			} else {
				debug('Reusing pooled agent for %s', poolKey);
			}
			return agent;
		}

		return new SocksProxyAgent(uri, opts);
	}

	/**
	 * Initiates a SOCKS connection to the specified SOCKS proxy server,
	 * which in turn connects to the specified remote host and port.
	 */
	async connect(
		req: http.ClientRequest,
		opts: AgentConnectOpts
	): Promise<net.Socket> {
		const { shouldLookup, proxy, timeout } = this;

		if (!opts.host) {
			throw new Error('No `host` defined!');
		}

		let { host } = opts;
		const { port, lookup: lookupFn = dns.lookup } = opts;

		if (shouldLookup) {
			// Try DNS cache first if enabled
			if (this.enableDNSCache) {
				const cached = dnsCache.get(host);
				if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
					host = cached.address;
					debug('Using cached DNS lookup for %s: %s', opts.host, host);
				} else {
					// Client-side DNS resolution for "4" and "5" socks proxy versions.
					host = await new Promise<string>((resolve, reject) => {
						// Use the request's custom lookup, if one was configured:
						lookupFn(host, {}, (err, res) => {
							if (err) {
								reject(err);
							} else {
								// Cache the result
								dnsCache.set(opts.host!, {
									address: res,
									timestamp: Date.now(),
								});
								debug('Cached DNS lookup for %s: %s', opts.host, res);
								resolve(res);
							}
						});
					});
				}
			} else {
				// Client-side DNS resolution for "4" and "5" socks proxy versions.
				host = await new Promise<string>((resolve, reject) => {
					// Use the request's custom lookup, if one was configured:
					lookupFn(host, {}, (err, res) => {
						if (err) {
							reject(err);
						} else {
							resolve(res);
						}
					});
				});
			}
		}

		const cacheKey = `${proxy.host}:${proxy.port}:${host}:${port}`;

		// Try to get cached socket if socket caching is enabled
		if (this.enableSocketCache) {
			const cachedSocket = getCachedSocket(cacheKey);
			if (cachedSocket && !cachedSocket.destroyed) {
				debug('Reusing existing socket connection');

				// For TLS connections, wrap the cached socket
				if (opts.secureEndpoint) {
					debug('Upgrading cached socket connection to TLS');
					const tlsSocket = tls.connect({
						...omit(
							setServernameFromNonIpHost(opts),
							'host',
							'path',
							'port'
						),
						socket: cachedSocket,
					});

					tlsSocket.once('error', (error) => {
						debug('Socket TLS error', error.message);
						releaseSocket(cacheKey, cachedSocket);
					});

					tlsSocket.once('close', () => {
						releaseSocket(cacheKey, cachedSocket);
					});

					return tlsSocket;
				}

				return cachedSocket;
			}
		}

		const socksOpts: SocksClientOptions = {
			proxy,
			destination: {
				host,
				port: typeof port === 'number' ? port : parseInt(port, 10),
			},
			command: 'connect',
			timeout: timeout ?? undefined,
			// @ts-expect-error the type supplied by socks for socket_options is wider
			// than necessary since socks will always override the host and port
			socket_options: this.socketOptions ?? undefined,
		};

		const cleanup = (tlsSocket?: tls.TLSSocket) => {
			req.destroy();
			socket.destroy();
			if (tlsSocket) tlsSocket.destroy();
		};

		debug('Creating socks proxy connection: %o', socksOpts);
		const { socket } = await SocksClient.createConnection(socksOpts);
		debug('Successfully created socks proxy connection');

		if (timeout !== null) {
			socket.setTimeout(timeout);
			socket.on('timeout', () => cleanup());
		}

		// Cache the socket for reuse if enabled
		if (this.enableSocketCache) {
			cacheSocket(cacheKey, socket);
		}

		if (opts.secureEndpoint) {
			// The proxy is connecting to a TLS server, so upgrade
			// this socket connection to a TLS connection.
			debug('Upgrading socket connection to TLS');
			const tlsSocket = tls.connect({
				...omit(
					setServernameFromNonIpHost(opts),
					'host',
					'path',
					'port'
				),
				socket,
			});

			tlsSocket.once('error', (error) => {
				debug('Socket TLS error', error.message);
				cleanup(tlsSocket);
			});

			return tlsSocket;
		}

		return socket;
	}
}

function omit<T extends object, K extends [...Array<keyof T>]>(
	obj: T,
	...keys: K
): {
	[K2 in Exclude<keyof T, K[number]>]: T[K2];
} {
	const ret = {} as { [K in keyof typeof obj]: (typeof obj)[K] };
	let key: keyof typeof obj;
	for (key in obj) {
		if (!keys.includes(key)) {
			ret[key] = obj[key];
		}
	}
	return ret;
}
