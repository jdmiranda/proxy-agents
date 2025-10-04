import { LookupAddress, LookupOptions, lookup } from 'dns';
import { GMT } from './index';

// DNS resolution cache with TTL
interface DNSCacheEntry {
	result: string | LookupAddress[];
	timestamp: number;
}

const DNS_CACHE = new Map<string, DNSCacheEntry>();
const DNS_CACHE_TTL = 300000; // 5 minutes in milliseconds

export function dnsLookup(
	host: string,
	opts: LookupOptions
): Promise<string | LookupAddress[]> {
	const cacheKey = `${host}:${opts.family}`;
	const now = Date.now();

	// Check cache
	const cached = DNS_CACHE.get(cacheKey);
	if (cached && (now - cached.timestamp) < DNS_CACHE_TTL) {
		return Promise.resolve(cached.result);
	}

	return new Promise((resolve, reject) => {
		lookup(host, opts, (err, res) => {
			if (err) {
				reject(err);
			} else {
				// Store in cache
				DNS_CACHE.set(cacheKey, {
					result: res,
					timestamp: now
				});

				// Cleanup old entries periodically (simple strategy)
				if (DNS_CACHE.size > 1000) {
					const entriesToDelete: string[] = [];
					for (const [key, entry] of DNS_CACHE.entries()) {
						if ((now - entry.timestamp) >= DNS_CACHE_TTL) {
							entriesToDelete.push(key);
						}
					}
					entriesToDelete.forEach(key => DNS_CACHE.delete(key));
				}

				resolve(res);
			}
		});
	});
}

export function isGMT(v?: string): v is GMT {
	return v === 'GMT';
}
