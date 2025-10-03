import createDebug from 'debug';
import { Readable } from 'stream';

// Built-in protocols
import { data } from './data';
import { file } from './file';
import { ftp } from './ftp';
import { http } from './http';
import { https } from './https';

const debug = createDebug('get-uri');

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type Protocol<T> = T extends `${infer Protocol}:${infer _}` ? Protocol : never;

export type GetUriProtocol<T> = (parsed: URL, opts?: T) => Promise<Readable>;

export const protocols = {
	data,
	file,
	ftp,
	http,
	https,
};

export type Protocols = typeof protocols;

export type ProtocolsOptions = {
	[P in keyof Protocols]: NonNullable<Parameters<Protocols[P]>[1]>;
};

export type ProtocolOpts<T> = {
	[P in keyof ProtocolsOptions]: Protocol<T> extends P
		? ProtocolsOptions[P]
		: never;
}[keyof Protocols];

const VALID_PROTOCOLS = new Set(Object.keys(protocols));

// Protocol handler cache - Map for O(1) lookup
const protocolHandlerCache = new Map<string, GetUriProtocol<any>>([
	['data', data],
	['file', file],
	['ftp', ftp],
	['http', http],
	['https', https],
]);

// URL parsing cache - LRU cache for parsed URLs (limit to 1000 entries)
const urlParseCache = new Map<string, URL>();
const URL_CACHE_MAX_SIZE = 1000;

export function isValidProtocol(p: string): p is keyof Protocols {
	return VALID_PROTOCOLS.has(p);
}

/**
 * Async function that returns a `stream.Readable` instance that will output
 * the contents of the given URI.
 *
 * For caching purposes, you can pass in a `stream` instance from a previous
 * `getUri()` call as a `cache: stream` option, and if the destination has
 * not changed since the last time the endpoint was retrieved then the callback
 * will be invoked with an Error object with `code` set to "ENOTMODIFIED" and
 * `null` for the "stream" instance argument. In this case, you can skip
 * retrieving the file again and continue to use the previous payload.
 *
 * @param {String} uri URI to retrieve
 * @param {Object} opts optional "options" object
 * @api public
 */
export async function getUri<Uri extends string>(
	uri: Uri | URL,
	opts?: ProtocolOpts<Uri>
): Promise<Readable> {
	debug('getUri(%o)', uri);

	if (!uri) {
		throw new TypeError('Must pass in a URI to "getUri()"');
	}

	// Fast path: if already a URL object, use it directly
	let url: URL;
	if (typeof uri === 'string') {
		// Check if we have a cached parsed URL for this string
		const cached = urlParseCache.get(uri);
		if (cached) {
			url = cached;
		} else {
			url = new URL(uri);
			// Cache the parsed URL with LRU eviction
			if (urlParseCache.size >= URL_CACHE_MAX_SIZE) {
				// Remove oldest entry (first key in Map)
				const firstKey = urlParseCache.keys().next().value;
				if (firstKey) {
					urlParseCache.delete(firstKey);
				}
			}
			urlParseCache.set(uri, url);
		}
	} else {
		url = uri;
	}

	// Strip trailing `:` - use slice for better performance than replace
	const protocol = url.protocol.endsWith(':')
		? url.protocol.slice(0, -1)
		: url.protocol;

	if (!isValidProtocol(protocol)) {
		throw new TypeError(
			`Unsupported protocol "${protocol}" specified in URI: "${uri}"`
		);
	}

	// Fast path: use Map cache for O(1) lookup
	const getter = protocolHandlerCache.get(protocol);
	if (!getter) {
		// Fallback to original method (should not happen for valid protocols)
		return protocols[protocol](url, opts as never);
	}

	return getter(url, opts as never);
}
