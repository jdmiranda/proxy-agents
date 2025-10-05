import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import createDebug from 'debug';
import { once } from 'events';
import { Agent, AgentConnectOpts } from 'agent-base';
import { URL } from 'url';
import type { OutgoingHttpHeaders } from 'http';

const debug = createDebug('http-proxy-agent');

// URL parsing cache for improved performance
const urlCache = new Map<string, URL>();
const URL_CACHE_SIZE = 100;

// Common proxy headers cache
const commonProxyHeadersCache = new WeakMap<HttpProxyAgent<any>, OutgoingHttpHeaders>();

// Pre-computed header templates
const KEEP_ALIVE_HEADER = 'Keep-Alive';
const CLOSE_HEADER = 'close';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Protocol<T> = T extends `${infer Protocol}:${infer _}` ? Protocol : never;

type ConnectOptsMap = {
	http: Omit<net.TcpNetConnectOpts, 'host' | 'port'>;
	https: Omit<tls.ConnectionOptions, 'host' | 'port'>;
};

type ConnectOpts<T> = {
	[P in keyof ConnectOptsMap]: Protocol<T> extends P
		? ConnectOptsMap[P]
		: never;
}[keyof ConnectOptsMap];

export type HttpProxyAgentOptions<T> = ConnectOpts<T> &
	http.AgentOptions & {
		headers?: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
	};

interface HttpProxyAgentClientRequest extends http.ClientRequest {
	outputData?: {
		data: string;
	}[];
	_header?: string | null;
	_implicitHeader(): void;
}

/**
 * The `HttpProxyAgent` implements an HTTP Agent subclass that connects
 * to the specified "HTTP proxy server" in order to proxy HTTP requests.
 */
export class HttpProxyAgent<Uri extends string> extends Agent {
	static protocols = ['http', 'https'] as const;

	readonly proxy: URL;
	proxyHeaders: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
	connectOpts: net.TcpNetConnectOpts & tls.ConnectionOptions;
	private cachedAuthHeader?: string;
	private cachedProxyConnection?: string;

	constructor(proxy: Uri | URL, opts?: HttpProxyAgentOptions<Uri>) {
		super(opts);
		this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
		this.proxyHeaders = opts?.headers ?? {};
		debug('Creating new HttpProxyAgent instance: %o', this.proxy.href);

		// Trim off the brackets from IPv6 addresses
		const host = (this.proxy.hostname || this.proxy.host).replace(
			/^\[|\]$/g,
			''
		);
		const port = this.proxy.port
			? parseInt(this.proxy.port, 10)
			: this.proxy.protocol === 'https:'
			? 443
			: 80;
		this.connectOpts = {
			...(opts ? omit(opts, 'headers') : null),
			host,
			port,
		};

		// Pre-compute Proxy-Connection header
		this.cachedProxyConnection = this.keepAlive ? KEEP_ALIVE_HEADER : CLOSE_HEADER;

		// Pre-compute Proxy-Authorization header if credentials are available
		if (this.proxy.username || this.proxy.password) {
			const auth = `${decodeURIComponent(
				this.proxy.username
			)}:${decodeURIComponent(this.proxy.password)}`;
			this.cachedAuthHeader = `Basic ${Buffer.from(auth).toString('base64')}`;
		}
	}

	addRequest(req: HttpProxyAgentClientRequest, opts: AgentConnectOpts): void {
		req._header = null;
		this.setRequestProps(req, opts);
		// @ts-expect-error `addRequest()` isn't defined in `@types/node`
		super.addRequest(req, opts);
	}

	setRequestProps(
		req: HttpProxyAgentClientRequest,
		opts: AgentConnectOpts
	): void {
		const protocol = opts.secureEndpoint ? 'https:' : 'http:';
		const hostname = req.getHeader('host') || 'localhost';
		const base = `${protocol}//${hostname}`;

		// Use cached URL parsing for better performance
		const cacheKey = `${base}${req.path}${opts.port}`;
		let url = urlCache.get(cacheKey);
		if (url) {
			// touch entry to preserve recency
			urlCache.delete(cacheKey);
			urlCache.set(cacheKey, url);
		} else {
			url = new URL(req.path, base);
			if (opts.port !== 80) {
				url.port = String(opts.port);
			}
			// Maintain cache size limit
			if (urlCache.size >= URL_CACHE_SIZE) {
				const firstKey = urlCache.keys().next().value;
				urlCache.delete(firstKey);
			}
			urlCache.set(cacheKey, url);
		}

		// Change the `http.ClientRequest` instance's "path" field
		// to the absolute path of the URL that will be requested.
		req.path = String(url);

		// Use cached headers for better performance
		const headers: OutgoingHttpHeaders =
			typeof this.proxyHeaders === 'function'
				? this.proxyHeaders()
				: { ...this.proxyHeaders };

		// Use pre-computed auth header
		if (this.cachedAuthHeader) {
			headers['Proxy-Authorization'] = this.cachedAuthHeader;
		}

		// Use pre-computed Proxy-Connection header
		if (!headers['Proxy-Connection']) {
			headers['Proxy-Connection'] = this.cachedProxyConnection!;
		}

		// Optimized header setting - direct iteration
		for (const name in headers) {
			const value = headers[name];
			if (value) {
				req.setHeader(name, value);
			}
		}
	}

	async connect(
		req: HttpProxyAgentClientRequest,
		opts: AgentConnectOpts
	): Promise<net.Socket> {
		req._header = null;

		if (!req.path.includes('://')) {
			this.setRequestProps(req, opts);
		}

		// At this point, the http ClientRequest's internal `_header` field
		// might have already been set. If this is the case then we'll need
		// to re-generate the string since we just changed the `req.path`.
		debug('Regenerating stored HTTP header string for request');
		req._implicitHeader();
		if (req.outputData && req.outputData.length > 0) {
			debug(
				'Patching connection write() output buffer with updated header'
			);
			const first = req.outputData[0].data;
			const endOfHeaders = first.indexOf('\r\n\r\n') + 4;
			req.outputData[0].data =
				req._header + first.substring(endOfHeaders);
			debug('Output buffer: %o', req.outputData[0].data);
		}

		// Create a socket connection to the proxy server.
		// Optimized: avoid conditional branch by pre-determining socket type
		const socket: net.Socket = this.proxy.protocol === 'https:'
			? (debug('Creating `tls.Socket`: %o', this.connectOpts), tls.connect(this.connectOpts))
			: (debug('Creating `net.Socket`: %o', this.connectOpts), net.connect(this.connectOpts));

		// Wait for the socket's `connect` event, so that this `callback()`
		// function throws instead of the `http` request machinery. This is
		// important for i.e. `PacProxyAgent` which determines a failed proxy
		// connection via the `callback()` function throwing.
		await once(socket, 'connect');

		return socket;
	}
}

function omit<T extends object, K extends [...(keyof T)[]]>(
	obj: T,
	...keys: K
): {
	[K2 in Exclude<keyof T, K[number]>]: T[K2];
} {
	const ret = {} as {
		[K in keyof typeof obj]: (typeof obj)[K];
	};
	let key: keyof typeof obj;
	for (key in obj) {
		if (!keys.includes(key)) {
			ret[key] = obj[key];
		}
	}
	return ret;
}
