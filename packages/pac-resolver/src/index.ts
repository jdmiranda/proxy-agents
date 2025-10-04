import { Context } from 'vm';
import { CompileOptions, compile } from 'degenerator';

/**
 * Built-in PAC functions.
 */
import dateRange from './dateRange';
import dnsDomainIs from './dnsDomainIs';
import dnsDomainLevels from './dnsDomainLevels';
import dnsResolve from './dnsResolve';
import isInNet from './isInNet';
import isPlainHostName from './isPlainHostName';
import isResolvable from './isResolvable';
import localHostOrDomainIs from './localHostOrDomainIs';
import myIpAddress from './myIpAddress';
import shExpMatch from './shExpMatch';
import timeRange from './timeRange';
import weekdayRange from './weekdayRange';
import type { QuickJSWASMModule } from '@tootallnate/quickjs-emscripten';

// Script compilation cache
interface CompiledResolverCacheEntry {
	resolver: (url: string, host: string) => Promise<string>;
	timestamp: number;
}

const COMPILED_RESOLVER_CACHE = new Map<string, CompiledResolverCacheEntry>();
const SCRIPT_CACHE_TTL = 3600000; // 1 hour in milliseconds

// FindProxyForURL result memoization cache
interface ProxyResultCacheEntry {
	result: string;
	timestamp: number;
}

const PROXY_RESULT_CACHE = new Map<string, ProxyResultCacheEntry>();
const RESULT_CACHE_TTL = 300000; // 5 minutes in milliseconds
const MAX_CACHE_SIZE = 10000;

/**
 * Returns an asynchronous `FindProxyForURL()` function
 * from the given JS string (from a PAC file).
 */
export function createPacResolver(
	qjs: QuickJSWASMModule,
	_str: string | Buffer,
	_opts: PacResolverOptions = {}
) {
	const str = Buffer.isBuffer(_str) ? _str.toString('utf8') : _str;

	// The sandbox to use for the `vm` context.
	const context: Context = {
		...sandbox,
		..._opts.sandbox,
	};

	// Construct the array of async function names to add `await` calls to.
	const names = Object.keys(context).filter((k) =>
		isAsyncFunction(context[k])
	);

	const opts: PacResolverOptions = {
		filename: 'proxy.pac',
		names,
		..._opts,
		sandbox: context,
	};

	// Only cache if using default sandbox (to avoid circular reference issues)
	const hasCustomSandbox = _opts.sandbox && Object.keys(_opts.sandbox).length > 0;
	const cacheKey = str;
	const now = Date.now();

	let resolver: (url: string, host: string) => Promise<string>;

	// Check if we have a cached compiled resolver (only if no custom sandbox)
	if (!hasCustomSandbox) {
		const cached = COMPILED_RESOLVER_CACHE.get(cacheKey);
		if (cached && (now - cached.timestamp) < SCRIPT_CACHE_TTL) {
			resolver = cached.resolver;
		} else {
			// Compile the JS `FindProxyForURL()` function into an async function.
			resolver = compile<string, [url: string, host: string]>(
				qjs,
				str,
				'FindProxyForURL',
				opts
			);

			// Cache the compiled resolver
			COMPILED_RESOLVER_CACHE.set(cacheKey, {
				resolver,
				timestamp: now
			});

			// Cleanup old compiled resolver cache entries
			if (COMPILED_RESOLVER_CACHE.size > 100) {
				const entriesToDelete: string[] = [];
				for (const [key, entry] of COMPILED_RESOLVER_CACHE.entries()) {
					if ((now - entry.timestamp) >= SCRIPT_CACHE_TTL) {
						entriesToDelete.push(key);
					}
				}
				entriesToDelete.forEach(key => COMPILED_RESOLVER_CACHE.delete(key));
			}
		}
	} else {
		// Don't cache when custom sandbox is provided
		resolver = compile<string, [url: string, host: string]>(
			qjs,
			str,
			'FindProxyForURL',
			opts
		);
	}

	function FindProxyForURL(
		url: string | URL,
		_host?: string
	): Promise<string> {
		const urlObj = typeof url === 'string' ? new URL(url) : url;
		const host = _host || urlObj.hostname;

		if (!host) {
			throw new TypeError('Could not determine `host`');
		}

		const urlHref = urlObj.href;
		const resultCacheKey = `${urlHref}:${host}`;
		const now = Date.now();

		// Check result cache
		const cachedResult = PROXY_RESULT_CACHE.get(resultCacheKey);
		if (cachedResult && (now - cachedResult.timestamp) < RESULT_CACHE_TTL) {
			return Promise.resolve(cachedResult.result);
		}

		// Execute resolver and cache result
		return resolver(urlHref, host).then(result => {
			PROXY_RESULT_CACHE.set(resultCacheKey, {
				result,
				timestamp: now
			});

			// Cleanup old result cache entries when it gets too large
			if (PROXY_RESULT_CACHE.size > MAX_CACHE_SIZE) {
				const entriesToDelete: string[] = [];
				let deletedCount = 0;
				const maxToDelete = Math.floor(MAX_CACHE_SIZE * 0.2); // Delete 20% of cache

				for (const [key, entry] of PROXY_RESULT_CACHE.entries()) {
					if ((now - entry.timestamp) >= RESULT_CACHE_TTL) {
						entriesToDelete.push(key);
						deletedCount++;
						if (deletedCount >= maxToDelete) break;
					}
				}

				// If not enough old entries, delete oldest entries
				if (deletedCount < maxToDelete) {
					const sortedEntries = Array.from(PROXY_RESULT_CACHE.entries())
						.sort((a, b) => a[1].timestamp - b[1].timestamp);

					for (let i = 0; i < maxToDelete - deletedCount && i < sortedEntries.length; i++) {
						entriesToDelete.push(sortedEntries[i][0]);
					}
				}

				entriesToDelete.forEach(key => PROXY_RESULT_CACHE.delete(key));
			}

			return result;
		});
	}

	Object.defineProperty(FindProxyForURL, 'toString', {
		value: () => resolver.toString(),
		enumerable: false,
	});

	return FindProxyForURL;
}

export type GMT = 'GMT';
export type Hour =
	| 0
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15
	| 16
	| 17
	| 18
	| 19
	| 20
	| 21
	| 22
	| 23;
export type Day =
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15
	| 16
	| 17
	| 18
	| 19
	| 20
	| 21
	| 22
	| 23
	| 24
	| 25
	| 26
	| 27
	| 28
	| 29
	| 30
	| 31;
export type Weekday = 'SUN' | 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT';
export type Month =
	| 'JAN'
	| 'FEB'
	| 'MAR'
	| 'APR'
	| 'MAY'
	| 'JUN'
	| 'JUL'
	| 'AUG'
	| 'SEP'
	| 'OCT'
	| 'NOV'
	| 'DEC';
export type PacResolverOptions = CompileOptions;
export interface FindProxyForURLCallback {
	(err?: Error | null, result?: string): void;
}
export type FindProxyForURL = ReturnType<typeof createPacResolver>;

export const sandbox = Object.freeze({
	alert: (message = '') => console.log('%s', message),
	dateRange,
	dnsDomainIs,
	dnsDomainLevels,
	dnsResolve,
	isInNet,
	isPlainHostName,
	isResolvable,
	localHostOrDomainIs,
	myIpAddress,
	shExpMatch,
	timeRange,
	weekdayRange,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isAsyncFunction(v: any): boolean {
	if (typeof v !== 'function') return false;
	// Native `AsyncFunction`
	if (v.constructor.name === 'AsyncFunction') return true;
	// TypeScript compiled
	if (String(v).indexOf('__awaiter(') !== -1) return true;
	// Legacy behavior - set `async` property on the function
	return Boolean(v.async);
}
