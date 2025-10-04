import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import { URL } from 'url';
// @ts-expect-error no types
import socks from 'socksv5';
import { listen } from 'async-listen';
import { req } from 'agent-base';
import { SocksProxyAgent } from '../src';

interface BenchmarkResult {
	name: string;
	requests: number;
	duration: number;
	requestsPerSecond: number;
	averageLatency: number;
}

async function runBenchmark(
	name: string,
	iterations: number,
	fn: () => Promise<void>
): Promise<BenchmarkResult> {
	const latencies: number[] = [];
	const start = Date.now();

	for (let i = 0; i < iterations; i++) {
		const reqStart = Date.now();
		await fn();
		latencies.push(Date.now() - reqStart);
	}

	const duration = Date.now() - start;
	const requestsPerSecond = (iterations / duration) * 1000;
	const averageLatency =
		latencies.reduce((a, b) => a + b, 0) / latencies.length;

	return {
		name,
		requests: iterations,
		duration,
		requestsPerSecond,
		averageLatency,
	};
}

describe('SocksProxyAgent Performance Benchmarks', () => {
	let httpServer: http.Server;
	let httpServerUrl: URL;
	let httpsServer: https.Server;
	let httpsServerUrl: URL;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let socksServer: any;
	let socksServerUrl: URL;

	beforeAll(async () => {
		// Setup SOCKS proxy server
		// @ts-expect-error no types for socksv5
		socksServer = socks.createServer(function (_info, accept) {
			accept();
		});
		await listen(socksServer, 0, '127.0.0.1');
		const { port, address } = socksServer.address();
		socksServerUrl = new URL(`socks://${address}:${port}`);
		socksServer.useAuth(socks.auth.None());

		// Setup target HTTP server
		httpServer = http.createServer((req, res) => {
			res.statusCode = 200;
			res.end(JSON.stringify({ ok: true }));
		});
		httpServerUrl = await listen(httpServer);

		// Setup target HTTPS server
		const options = {
			key: fs.readFileSync(
				path.resolve(__dirname, 'ssl-cert-snakeoil.key')
			),
			cert: fs.readFileSync(
				path.resolve(__dirname, 'ssl-cert-snakeoil.pem')
			),
		};
		httpsServer = https.createServer(options, (req, res) => {
			res.statusCode = 200;
			res.end(JSON.stringify({ ok: true }));
		});
		httpsServerUrl = await listen(httpsServer);
	});

	afterAll(() => {
		httpServer.close();
		httpsServer.close();
		socksServer.close();
	});

	it('Benchmark: Agent Pooling vs New Agent per Request', async () => {
		const iterations = 100;

		// Benchmark: New agent per request (no pooling)
		const noPooringResult = await runBenchmark(
			'No Pooling (new agent per request)',
			iterations,
			async () => {
				const agent = new SocksProxyAgent(socksServerUrl, {
					enablePooling: false,
				});
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		// Benchmark: Agent pooling
		const poolingResult = await runBenchmark(
			'With Agent Pooling',
			iterations,
			async () => {
				const agent = SocksProxyAgent.getAgent(socksServerUrl);
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		console.log('\n=== Agent Pooling Benchmark ===');
		console.log(`No Pooling: ${noPooringResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${noPooringResult.averageLatency.toFixed(2)}ms)`);
		console.log(`With Pooling: ${poolingResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${poolingResult.averageLatency.toFixed(2)}ms)`);
		console.log(`Improvement: ${((poolingResult.requestsPerSecond / noPooringResult.requestsPerSecond - 1) * 100).toFixed(2)}%`);
	}, 60000);

	it('Benchmark: DNS Caching', async () => {
		const iterations = 50;

		// Benchmark: Without DNS cache
		const noCacheResult = await runBenchmark(
			'No DNS Cache',
			iterations,
			async () => {
				const agent = new SocksProxyAgent(
					socksServerUrl.href.replace('socks', 'socks5'),
					{ enableDNSCache: false }
				);
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		// Benchmark: With DNS cache
		const cacheResult = await runBenchmark(
			'With DNS Cache',
			iterations,
			async () => {
				const agent = new SocksProxyAgent(
					socksServerUrl.href.replace('socks', 'socks5'),
					{ enableDNSCache: true }
				);
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		console.log('\n=== DNS Caching Benchmark ===');
		console.log(`No DNS Cache: ${noCacheResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${noCacheResult.averageLatency.toFixed(2)}ms)`);
		console.log(`With DNS Cache: ${cacheResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${cacheResult.averageLatency.toFixed(2)}ms)`);
		console.log(`Improvement: ${((cacheResult.requestsPerSecond / noCacheResult.requestsPerSecond - 1) * 100).toFixed(2)}%`);
	}, 60000);

	it('Benchmark: Socket Caching and Reuse', async () => {
		const iterations = 100;

		// Benchmark: Without socket cache
		const noSocketCacheResult = await runBenchmark(
			'No Socket Cache',
			iterations,
			async () => {
				const agent = new SocksProxyAgent(socksServerUrl, {
					enableSocketCache: false,
				});
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		// Benchmark: With socket cache
		const socketCacheResult = await runBenchmark(
			'With Socket Cache',
			iterations,
			async () => {
				const agent = new SocksProxyAgent(socksServerUrl, {
					enableSocketCache: true,
				});
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		console.log('\n=== Socket Caching Benchmark ===');
		console.log(`No Socket Cache: ${noSocketCacheResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${noSocketCacheResult.averageLatency.toFixed(2)}ms)`);
		console.log(`With Socket Cache: ${socketCacheResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${socketCacheResult.averageLatency.toFixed(2)}ms)`);
		console.log(`Improvement: ${((socketCacheResult.requestsPerSecond / noSocketCacheResult.requestsPerSecond - 1) * 100).toFixed(2)}%`);
	}, 60000);

	it('Benchmark: All Optimizations Combined', async () => {
		const iterations = 100;

		// Benchmark: No optimizations
		const noOptResult = await runBenchmark(
			'No Optimizations',
			iterations,
			async () => {
				const agent = new SocksProxyAgent(socksServerUrl, {
					enablePooling: false,
					enableDNSCache: false,
					keepAlive: false,
				});
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		// Benchmark: Optimizations enabled (agent pooling + DNS cache + keep-alive)
		const allOptResult = await runBenchmark(
			'All Optimizations',
			iterations,
			async () => {
				const agent = SocksProxyAgent.getAgent(socksServerUrl);
				await req(new URL('/test', httpServerUrl), { agent });
			}
		);

		console.log('\n=== Combined Optimizations Benchmark ===');
		console.log(`No Optimizations: ${noOptResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${noOptResult.averageLatency.toFixed(2)}ms)`);
		console.log(`All Optimizations: ${allOptResult.requestsPerSecond.toFixed(2)} req/s (avg latency: ${allOptResult.averageLatency.toFixed(2)}ms)`);
		console.log(`Overall Improvement: ${((allOptResult.requestsPerSecond / noOptResult.requestsPerSecond - 1) * 100).toFixed(2)}%`);
		console.log(`Latency Reduction: ${((1 - allOptResult.averageLatency / noOptResult.averageLatency) * 100).toFixed(2)}%`);
	}, 60000);

	it('Benchmark: High Concurrency Test', async () => {
		const concurrency = 50;
		const requestsPerWorker = 10;

		const startNoOpt = Date.now();
		await Promise.all(
			Array.from({ length: concurrency }, async () => {
				for (let i = 0; i < requestsPerWorker; i++) {
					const agent = new SocksProxyAgent(socksServerUrl, {
						enablePooling: false,
						enableDNSCache: false,
						keepAlive: false,
					});
					await req(new URL('/test', httpServerUrl), { agent });
				}
			})
		);
		const durationNoOpt = Date.now() - startNoOpt;

		const startOpt = Date.now();
		await Promise.all(
			Array.from({ length: concurrency }, async () => {
				for (let i = 0; i < requestsPerWorker; i++) {
					const agent = SocksProxyAgent.getAgent(socksServerUrl);
					await req(new URL('/test', httpServerUrl), { agent });
				}
			})
		);
		const durationOpt = Date.now() - startOpt;

		const totalRequests = concurrency * requestsPerWorker;
		console.log('\n=== High Concurrency Benchmark ===');
		console.log(`Total Requests: ${totalRequests}`);
		console.log(`Concurrency: ${concurrency}`);
		console.log(`No Optimizations: ${durationNoOpt}ms (${((totalRequests / durationNoOpt) * 1000).toFixed(2)} req/s)`);
		console.log(`All Optimizations: ${durationOpt}ms (${((totalRequests / durationOpt) * 1000).toFixed(2)} req/s)`);
		console.log(`Speedup: ${((durationNoOpt / durationOpt - 1) * 100).toFixed(2)}%`);
	}, 120000);
});
