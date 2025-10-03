import { Readable } from 'stream';
import createDebug from 'debug';
import { Stats, createReadStream, promises as fsPromises } from 'fs';
import { GetUriProtocol } from './';
import NotFoundError from './notfound';
import NotModifiedError from './notmodified';
import { fileURLToPath } from 'url';

const debug = createDebug('get-uri:file');

type ReadStreamOptions = NonNullable<
	Exclude<Parameters<typeof createReadStream>[1], string>
>;

interface FileReadable extends Readable {
	stat?: Stats;
}

export interface FileOptions extends ReadStreamOptions {
	cache?: FileReadable;
}

/**
 * Returns a `fs.ReadStream` instance from a "file:" URI.
 */

export const file: GetUriProtocol<FileOptions> = async (
	{ href: uri },
	opts = {}
) => {
	const {
		cache,
		flags = 'r',
		mode = 438, // =0666
	} = opts;

	try {
		// Convert URI → Path
		const filepath = fileURLToPath(uri);
		debug('Normalized pathname: %o', filepath);

		// Fast path: if no cache, skip stat check and open file directly
		if (!cache || !cache.stat) {
			// Open file and get fd
			const fdHandle = await fsPromises.open(filepath, flags, mode);
			const fd = fdHandle.fd;

			// Get stat for future cache use
			const stat = await fdHandle.stat();

			// Create read stream - fd is closed by autoClose
			const rs = createReadStream(filepath, {
				autoClose: true,
				...opts,
				fd,
			}) as FileReadable;
			rs.stat = stat;
			return rs;
		}

		// Cache validation path
		const fdHandle = await fsPromises.open(filepath, flags, mode);
		const fd = fdHandle.fd;
		const stat = await fdHandle.stat();

		// Check if file has not been modified
		if (isNotModified(cache.stat, stat)) {
			await fdHandle.close();
			throw new NotModifiedError();
		}

		// File was modified, return new stream
		const rs = createReadStream(filepath, {
			autoClose: true,
			...opts,
			fd,
		}) as FileReadable;
		rs.stat = stat;
		return rs;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new NotFoundError();
		}
		throw err;
	}
};

// returns `true` if the `mtime` of the 2 stat objects are equal
function isNotModified(prev: Stats, curr: Stats): boolean {
	return +prev.mtime === +curr.mtime;
}
