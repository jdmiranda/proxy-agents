export interface ParsedDataURI {
	type: string;
	typeFull: string;
	charset: string;
	buffer: ArrayBuffer;
}

export interface IBufferConversions {
	base64ToArrayBuffer(base64: string): ArrayBuffer;
	stringToBuffer(str: string): ArrayBuffer;
}

// Simple LRU cache implementation for parsed data URIs
class LRUCache<K, V> {
	private maxSize: number;
	private cache: Map<K, V>;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
		this.cache = new Map();
	}

	get(key: K): V | undefined {
		if (!this.cache.has(key)) return undefined;
		// Move to end to mark as recently used
		const value = this.cache.get(key)!;
		this.cache.delete(key);
		this.cache.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		// Delete if exists (to reorder)
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		// Add to end
		this.cache.set(key, value);
		// Remove oldest if over capacity
		if (this.cache.size > this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			this.cache.delete(firstKey);
		}
	}
}

// Cache for parsed data URIs (max 100 entries)
const dataUriCache = new LRUCache<string, ParsedDataURI>(100);

// Common media types for fast path detection
const commonMediaTypes = new Set([
	'text/plain',
	'text/html',
	'text/css',
	'application/json',
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/svg+xml'
]);

/**
 * Returns a `Buffer` instance from the given data URI `uri`.
 *
 * @param {String} uri Data URI to turn into a Buffer instance
 */
export const makeDataUriToBuffer =
	(convert: IBufferConversions) =>
	(uri: string | URL): ParsedDataURI => {
		uri = String(uri);

		// Check cache first
		const cached = dataUriCache.get(uri);
		if (cached) {
			return cached;
		}

		// Fast path: check for data: prefix
		if (uri.charCodeAt(0) !== 100 || uri.charCodeAt(1) !== 97 ||
		    uri.charCodeAt(2) !== 116 || uri.charCodeAt(3) !== 97 ||
		    uri.charCodeAt(4) !== 58) {
			throw new TypeError(
				'`uri` does not appear to be a Data URI (must begin with "data:")'
			);
		}

		// strip newlines
		uri = uri.replace(/\r?\n/g, '');

		// split the URI up into the "metadata" and the "data" portions
		const firstComma = uri.indexOf(',');
		if (firstComma === -1 || firstComma <= 4) {
			throw new TypeError('malformed data: URI');
		}

		// remove the "data:" scheme and parse the metadata
		const meta = uri.substring(5, firstComma).split(';');

		let charset = '';
		let base64 = false;
		const type = meta[0] || 'text/plain';
		let typeFull = type;
		for (let i = 1; i < meta.length; i++) {
			if (meta[i] === 'base64') {
				base64 = true;
			} else if (meta[i]) {
				typeFull += `;${meta[i]}`;
				if (meta[i].indexOf('charset=') === 0) {
					charset = meta[i].substring(8);
				}
			}
		}
		// defaults to US-ASCII only if type is not provided
		if (!meta[0] && !charset.length) {
			typeFull += ';charset=US-ASCII';
			charset = 'US-ASCII';
		}

		// get the encoded data portion and decode URI-encoded chars
		const data = unescape(uri.substring(firstComma + 1));
		const buffer = base64
			? convert.base64ToArrayBuffer(data)
			: convert.stringToBuffer(data);

		const result = {
			type,
			typeFull,
			charset,
			buffer,
		};

		// Cache the result for common media types or small URIs
		if (commonMediaTypes.has(type) || uri.length < 10000) {
			dataUriCache.set(uri, result);
		}

		return result;
	};
