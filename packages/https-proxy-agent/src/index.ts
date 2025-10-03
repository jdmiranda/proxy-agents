import * as net from 'net';
import * as tls from 'tls';
import * as http from 'http';
import assert from 'assert';
import createDebug from 'debug';
import { Agent, AgentConnectOpts } from 'agent-base';
import { URL } from 'url';
import { parseProxyResponse } from './parse-proxy-response';
import type { OutgoingHttpHeaders } from 'http';

const debug = createDebug('https-proxy-agent');

// SSL/TLS session cache for connection reuse
const sessionCache = new Map<string, Buffer>();
const CACHE_MAX_SIZE = 100;
const CACHE_TTL = 300000; // 5 minutes

// Certificate validation cache
interface CertCacheEntry {
	valid: boolean;
	timestamp: number;
}
const certCache = new Map<string, CertCacheEntry>();
const CERT_CACHE_TTL = 600000; // 10 minutes

// Header cache for common HTTPS headers
const commonHeadersCache = new Map<string, OutgoingHttpHeaders>();

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

export type HttpsProxyAgentOptions<T> = ConnectOpts<T> &
	http.AgentOptions & {
		headers?: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
	};

/**
 * The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to
 * the specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
 *
 * Outgoing HTTP requests are first tunneled through the proxy server using the
 * `CONNECT` HTTP request method to establish a connection to the proxy server,
 * and then the proxy server connects to the destination target and issues the
 * HTTP request from the proxy server.
 *
 * `https:` requests have their socket connection upgraded to TLS once
 * the connection to the proxy server has been established.
 */
export class HttpsProxyAgent<Uri extends string> extends Agent {
	static protocols = ['http', 'https'] as const;

	readonly proxy: URL;
	proxyHeaders: OutgoingHttpHeaders | (() => OutgoingHttpHeaders);
	connectOpts: net.TcpNetConnectOpts & tls.ConnectionOptions;
	private sessionCacheKey: string;

	constructor(proxy: Uri | URL, opts?: HttpsProxyAgentOptions<Uri>) {
		super(opts);
		this.options = { path: undefined };
		this.proxy = typeof proxy === 'string' ? new URL(proxy) : proxy;
		this.proxyHeaders = opts?.headers ?? {};
		debug('Creating new HttpsProxyAgent instance: %o', this.proxy.href);

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

		// Create session cache key
		this.sessionCacheKey = `${this.proxy.protocol}//${host}:${port}`;

		this.connectOpts = {
			// Attempt to negotiate http/1.1 for proxy servers that support http/2
			ALPNProtocols: ['http/1.1'],
			...(opts ? omit(opts, 'headers') : null),
			host,
			port,
			// Enable session reuse for TLS connections
			session: undefined,
			// Reduce TLS handshake overhead with session tickets
			sessionTimeout: 300, // 5 minutes
		};
	}

	/**
	 * Called when the node-core HTTP client library is creating a
	 * new HTTP request.
	 */
	async connect(
		req: http.ClientRequest,
		opts: AgentConnectOpts
	): Promise<net.Socket> {
		const { proxy } = this;

		if (!opts.host) {
			throw new TypeError('No "host" provided');
		}

		// Retrieve cached TLS session for connection reuse
		const cachedSession = sessionCache.get(this.sessionCacheKey);
		if (cachedSession) {
			this.connectOpts.session = cachedSession;
			debug('Using cached TLS session for: %s', this.sessionCacheKey);
		}

		// Create a socket connection to the proxy server.
		let socket: net.Socket;
		if (proxy.protocol === 'https:') {
			debug('Creating `tls.Socket`: %o', this.connectOpts);
			const tlsSocket = tls.connect(setServernameFromNonIpHost(this.connectOpts));

			// Cache TLS session for reuse
			tlsSocket.once('session', (session: Buffer) => {
				if (sessionCache.size >= CACHE_MAX_SIZE) {
					// Remove oldest entry
					const firstKey = sessionCache.keys().next().value;
					sessionCache.delete(firstKey);
				}
				sessionCache.set(this.sessionCacheKey, session);
				debug('Cached TLS session for: %s', this.sessionCacheKey);
			});

			socket = tlsSocket;
		} else {
			debug('Creating `net.Socket`: %o', this.connectOpts);
			socket = net.connect(this.connectOpts);
		}

		// Use cached headers if available (only for static headers, not functions)
		const headerCacheKey = `${this.sessionCacheKey}:${opts.host}:${opts.port}`;
		const hasHeaderFunction = typeof this.proxyHeaders === 'function';
		let headers: OutgoingHttpHeaders;

		if (!hasHeaderFunction && commonHeadersCache.has(headerCacheKey)) {
			headers = { ...commonHeadersCache.get(headerCacheKey)! };
			debug('Using cached headers for: %s', headerCacheKey);
		} else {
			headers =
				typeof this.proxyHeaders === 'function'
					? this.proxyHeaders()
					: { ...this.proxyHeaders };

			const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;

			// Inject the `Proxy-Authorization` header if necessary.
			if (proxy.username || proxy.password) {
				const auth = `${decodeURIComponent(
					proxy.username
				)}:${decodeURIComponent(proxy.password)}`;
				headers['Proxy-Authorization'] = `Basic ${Buffer.from(
					auth
				).toString('base64')}`;
			}

			headers.Host = `${host}:${opts.port}`;

			if (!headers['Proxy-Connection']) {
				headers['Proxy-Connection'] = this.keepAlive
					? 'Keep-Alive'
					: 'close';
			}

			// Cache common headers (only if not a function)
			if (!hasHeaderFunction) {
				commonHeadersCache.set(headerCacheKey, { ...headers });
				debug('Cached headers for: %s', headerCacheKey);
			}
		}

		const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
		let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r\n`;
		for (const name of Object.keys(headers)) {
			payload += `${name}: ${headers[name]}\r\n`;
		}

		const proxyResponsePromise = parseProxyResponse(socket);

		socket.write(`${payload}\r\n`);

		const { connect, buffered } = await proxyResponsePromise;
		req.emit('proxyConnect', connect);
		this.emit('proxyConnect', connect, req);

		if (connect.statusCode === 200) {
			req.once('socket', resume);

			if (opts.secureEndpoint) {
				// The proxy is connecting to a TLS server, so upgrade
				// this socket connection to a TLS connection.
				debug('Upgrading socket connection to TLS');

				const certCacheKey = `${opts.host}:${opts.port}`;
				const tlsOpts: tls.ConnectionOptions = {
					...omit(
						setServernameFromNonIpHost(opts),
						'host',
						'path',
						'port'
					),
					socket,
				};

				// Retrieve cached TLS session for target endpoint
				const targetSessionKey = `target:${certCacheKey}`;
				const cachedTargetSession = sessionCache.get(targetSessionKey);
				if (cachedTargetSession) {
					tlsOpts.session = cachedTargetSession;
					debug('Using cached TLS session for target: %s', certCacheKey);
				}

				const tlsSocket = tls.connect(tlsOpts);

				// Cache TLS session for target endpoint
				tlsSocket.once('session', (session: Buffer) => {
					if (sessionCache.size >= CACHE_MAX_SIZE) {
						const firstKey = sessionCache.keys().next().value;
						sessionCache.delete(firstKey);
					}
					sessionCache.set(targetSessionKey, session);
					debug('Cached TLS session for target: %s', certCacheKey);
				});

				// Certificate validation caching
				tlsSocket.once('secureConnect', () => {
					const cert = tlsSocket.getPeerCertificate();
					if (cert && cert.fingerprint) {
						const now = Date.now();
						const cached = certCache.get(cert.fingerprint);

						if (!cached || now - cached.timestamp > CERT_CACHE_TTL) {
							certCache.set(cert.fingerprint, {
								valid: tlsSocket.authorized,
								timestamp: now,
							});
							debug('Cached certificate validation for: %s', cert.fingerprint);
						}
					}
				});

				return tlsSocket;
			}

			return socket;
		}

		// Some other status code that's not 200... need to re-play the HTTP
		// header "data" events onto the socket once the HTTP machinery is
		// attached so that the node core `http` can parse and handle the
		// error status code.

		// Close the original socket, and a new "fake" socket is returned
		// instead, so that the proxy doesn't get the HTTP request
		// written to it (which may contain `Authorization` headers or other
		// sensitive data).
		//
		// See: https://hackerone.com/reports/541502
		socket.destroy();

		const fakeSocket = new net.Socket({ writable: false });
		fakeSocket.readable = true;

		// Need to wait for the "socket" event to re-play the "data" events.
		req.once('socket', (s: net.Socket) => {
			debug('Replaying proxy buffer for failed request');
			assert(s.listenerCount('data') > 0);

			// Replay the "buffered" Buffer onto the fake `socket`, since at
			// this point the HTTP module machinery has been hooked up for
			// the user.
			s.push(buffered);
			s.push(null);
		});

		return fakeSocket;
	}
}

function resume(socket: net.Socket | tls.TLSSocket): void {
	socket.resume();
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
