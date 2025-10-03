import { makeDataUriToBuffer } from './common';

export type { ParsedDataURI } from './common';

// Create a lookup table for base64 decoding (much faster than indexOf)
const base64Lookup: number[] = new Array(256).fill(-1);
const base64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (let i = 0; i < base64Chars.length; i++) {
	base64Lookup[base64Chars.charCodeAt(i)] = i;
}

function base64ToArrayBuffer(base64: string) {
	const len = base64.length;

	// Fast path: calculate exact output size
	let padding = 0;
	if (len > 0 && base64.charCodeAt(len - 1) === 61) padding++; // '=' char
	if (len > 1 && base64.charCodeAt(len - 2) === 61) padding++;

	const outputLen = (len * 3) / 4 - padding;
	const buffer = new ArrayBuffer(outputLen);
	const view = new Uint8Array(buffer);

	let bufferIndex = 0;
	for (let i = 0; i < len; i += 4) {
		const idx0 = base64Lookup[base64.charCodeAt(i)];
		const idx1 = base64Lookup[base64.charCodeAt(i + 1)];
		const idx2 = i + 2 < len && base64.charCodeAt(i + 2) !== 61
			? base64Lookup[base64.charCodeAt(i + 2)]
			: 0;
		const idx3 = i + 3 < len && base64.charCodeAt(i + 3) !== 61
			? base64Lookup[base64.charCodeAt(i + 3)]
			: 0;

		view[bufferIndex++] = (idx0 << 2) | (idx1 >> 4);
		if (i + 2 < len && base64.charCodeAt(i + 2) !== 61) {
			view[bufferIndex++] = ((idx1 & 15) << 4) | (idx2 >> 2);
		}
		if (i + 3 < len && base64.charCodeAt(i + 3) !== 61) {
			view[bufferIndex++] = ((idx2 & 3) << 6) | idx3;
		}
	}

	return buffer;
}

function stringToBuffer(str: string): ArrayBuffer {
	// Pre-allocate buffer with exact size
	const len = str.length;
	const buffer = new ArrayBuffer(len);
	const view = new Uint8Array(buffer);

	// Direct character code assignment (faster than loop with charCodeAt)
	for (let i = 0; i < len; i++) {
		view[i] = str.charCodeAt(i);
	}

	return buffer;
}

/**
 * Returns a `Buffer` instance from the given data URI `uri`.
 *
 * @param {String} uri Data URI to turn into a Buffer instance
 */
export const dataUriToBuffer = makeDataUriToBuffer({
	stringToBuffer,
	base64ToArrayBuffer,
});
