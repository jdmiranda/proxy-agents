/**
 * Benchmark suite for http-proxy-agent optimizations
 * Tests connection establishment, request throughput, and connection reuse
 */

const http = require('http');
const { HttpProxyAgent } = require('./dist');
const { performance } = require('perf_hooks');

// Configuration
const WARMUP_REQUESTS = 10;
const BENCHMARK_REQUESTS = 100;
const CONCURRENT_REQUESTS = 10;

// Mock proxy server for benchmarking
let proxyServer;
let targetServer;

// Statistics
const stats = {
	connectionEstablishment: [],
	requestThroughput: [],
	connectionReuse: 0,
	totalConnections: 0,
	errors: 0
};

// Setup mock servers
async function setupServers() {
	return new Promise((resolve) => {
		// Target server
		targetServer = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('OK');
		});

		targetServer.listen(0, () => {
			const targetPort = targetServer.address().port;
			console.log(`Target server listening on port ${targetPort}`);

			// Proxy server
			proxyServer = http.createServer((req, res) => {
				// Simple proxy implementation for benchmarking
				const proxyReq = http.request({
					hostname: 'localhost',
					port: targetPort,
					path: req.url,
					method: req.method,
					headers: req.headers
				}, (proxyRes) => {
					res.writeHead(proxyRes.statusCode, proxyRes.headers);
					proxyRes.pipe(res);
				});

				proxyReq.on('error', (err) => {
					console.error('Proxy request error:', err);
					stats.errors++;
					res.writeHead(502);
					res.end('Bad Gateway');
				});

				req.pipe(proxyReq);
			});

			proxyServer.listen(0, () => {
				const proxyPort = proxyServer.address().port;
				console.log(`Proxy server listening on port ${proxyPort}`);
				resolve({ proxyPort, targetPort });
			});
		});
	});
}

// Cleanup servers
function cleanupServers() {
	return Promise.all([
		new Promise((resolve) => proxyServer.close(resolve)),
		new Promise((resolve) => targetServer.close(resolve))
	]);
}

// Benchmark: Connection establishment speed
async function benchmarkConnectionEstablishment(proxyUrl, iterations = 50) {
	console.log('\n=== Benchmark: Connection Establishment Speed ===');
	const times = [];

	for (let i = 0; i < iterations; i++) {
		const agent = new HttpProxyAgent(proxyUrl, { keepAlive: false });
		const start = performance.now();

		await new Promise((resolve, reject) => {
			const req = http.request({
				hostname: 'localhost',
				port: targetServer.address().port,
				path: '/test',
				agent
			}, (res) => {
				res.resume();
				res.on('end', () => {
					const duration = performance.now() - start;
					times.push(duration);
					stats.totalConnections++;
					resolve();
				});
			});

			req.on('error', (err) => {
				stats.errors++;
				reject(err);
			});

			req.end();
		});

		agent.destroy();
	}

	const avg = times.reduce((a, b) => a + b, 0) / times.length;
	const min = Math.min(...times);
	const max = Math.max(...times);

	console.log(`Average: ${avg.toFixed(2)}ms`);
	console.log(`Min: ${min.toFixed(2)}ms`);
	console.log(`Max: ${max.toFixed(2)}ms`);

	stats.connectionEstablishment = { avg, min, max };
	return { avg, min, max };
}

// Benchmark: Request throughput
async function benchmarkRequestThroughput(proxyUrl, iterations = 100) {
	console.log('\n=== Benchmark: Request Throughput ===');
	const agent = new HttpProxyAgent(proxyUrl, { keepAlive: true });
	const start = performance.now();

	const requests = [];
	for (let i = 0; i < iterations; i++) {
		requests.push(
			new Promise((resolve, reject) => {
				const req = http.request({
					hostname: 'localhost',
					port: targetServer.address().port,
					path: `/test-${i}`,
					agent
				}, (res) => {
					res.resume();
					res.on('end', resolve);
				});

				req.on('error', (err) => {
					stats.errors++;
					reject(err);
				});

				req.end();
			})
		);
	}

	await Promise.all(requests);
	const duration = performance.now() - start;
	const throughput = (iterations / duration) * 1000;

	console.log(`Total time: ${duration.toFixed(2)}ms`);
	console.log(`Throughput: ${throughput.toFixed(2)} req/sec`);
	console.log(`Average per request: ${(duration / iterations).toFixed(2)}ms`);

	stats.requestThroughput = { duration, throughput, avgPerRequest: duration / iterations };
	agent.destroy();
	return { duration, throughput };
}

// Benchmark: Connection reuse effectiveness
async function benchmarkConnectionReuse(proxyUrl, iterations = 50) {
	console.log('\n=== Benchmark: Connection Reuse Effectiveness ===');
	const agent = new HttpProxyAgent(proxyUrl, {
		keepAlive: true,
		maxSockets: 5,
		maxFreeSockets: 2
	});

	let socketCreations = 0;
	const originalCreateConnection = agent.createConnection;
	agent.createConnection = function(...args) {
		socketCreations++;
		return originalCreateConnection.apply(this, args);
	};

	const requests = [];
	for (let i = 0; i < iterations; i++) {
		requests.push(
			new Promise((resolve, reject) => {
				const req = http.request({
					hostname: 'localhost',
					port: targetServer.address().port,
					path: `/reuse-test-${i}`,
					agent
				}, (res) => {
					res.resume();
					res.on('end', resolve);
				});

				req.on('error', (err) => {
					stats.errors++;
					reject(err);
				});

				req.end();
			})
		);
	}

	await Promise.all(requests);

	const reuseRate = ((iterations - socketCreations) / iterations * 100).toFixed(2);
	console.log(`Total requests: ${iterations}`);
	console.log(`Socket creations: ${socketCreations}`);
	console.log(`Reuse rate: ${reuseRate}%`);

	stats.connectionReuse = { totalRequests: iterations, socketCreations, reuseRate };
	agent.destroy();
	return { socketCreations, reuseRate };
}

// Benchmark: URL parsing cache effectiveness
async function benchmarkUrlCaching(proxyUrl, iterations = 1000) {
	console.log('\n=== Benchmark: URL Parsing Cache Effectiveness ===');
	const agent = new HttpProxyAgent(proxyUrl, { keepAlive: true });

	// Test with repeated URLs (cache hits)
	const start1 = performance.now();
	for (let i = 0; i < iterations; i++) {
		await new Promise((resolve, reject) => {
			const req = http.request({
				hostname: 'localhost',
				port: targetServer.address().port,
				path: '/cached-path',
				agent
			}, (res) => {
				res.resume();
				res.on('end', resolve);
			});
			req.on('error', reject);
			req.end();
		});
	}
	const cachedTime = performance.now() - start1;

	console.log(`Cached URLs (${iterations} requests): ${cachedTime.toFixed(2)}ms`);
	console.log(`Average: ${(cachedTime / iterations).toFixed(2)}ms per request`);

	agent.destroy();
	return { cachedTime };
}

// Benchmark: Header caching performance
async function benchmarkHeaderCaching(proxyUrl, iterations = 100) {
	console.log('\n=== Benchmark: Header Caching Performance ===');

	// Agent with pre-computed headers
	const agentWithCache = new HttpProxyAgent(proxyUrl, {
		keepAlive: true
	});

	const start = performance.now();
	const requests = [];
	for (let i = 0; i < iterations; i++) {
		requests.push(
			new Promise((resolve, reject) => {
				const req = http.request({
					hostname: 'localhost',
					port: targetServer.address().port,
					path: `/header-test-${i}`,
					agent: agentWithCache
				}, (res) => {
					res.resume();
					res.on('end', resolve);
				});
				req.on('error', reject);
				req.end();
			})
		);
	}

	await Promise.all(requests);
	const duration = performance.now() - start;

	console.log(`With cached headers (${iterations} requests): ${duration.toFixed(2)}ms`);
	console.log(`Average: ${(duration / iterations).toFixed(2)}ms per request`);

	agentWithCache.destroy();
	return { duration };
}

// Main benchmark runner
async function runBenchmarks() {
	console.log('Starting http-proxy-agent benchmarks...\n');

	const { proxyPort, targetPort } = await setupServers();
	const proxyUrl = `http://localhost:${proxyPort}`;

	console.log(`\nRunning benchmarks with ${BENCHMARK_REQUESTS} iterations...\n`);

	try {
		// Warmup
		console.log('Warming up...');
		const warmupAgent = new HttpProxyAgent(proxyUrl, { keepAlive: true });
		for (let i = 0; i < WARMUP_REQUESTS; i++) {
			await new Promise((resolve) => {
				const req = http.request({
					hostname: 'localhost',
					port: targetPort,
					path: '/warmup',
					agent: warmupAgent
				}, (res) => {
					res.resume();
					res.on('end', resolve);
				});
				req.end();
			});
		}
		warmupAgent.destroy();
		console.log('Warmup complete.\n');

		// Run benchmarks
		await benchmarkConnectionEstablishment(proxyUrl, 50);
		await benchmarkRequestThroughput(proxyUrl, BENCHMARK_REQUESTS);
		await benchmarkConnectionReuse(proxyUrl, 50);
		await benchmarkUrlCaching(proxyUrl, 200);
		await benchmarkHeaderCaching(proxyUrl, BENCHMARK_REQUESTS);

		// Print summary
		console.log('\n=== Benchmark Summary ===');
		console.log(JSON.stringify(stats, null, 2));
		console.log(`\nTotal connections: ${stats.totalConnections}`);
		console.log(`Total errors: ${stats.errors}`);

	} catch (error) {
		console.error('Benchmark error:', error);
	} finally {
		await cleanupServers();
	}
}

// Run if called directly
if (require.main === module) {
	runBenchmarks().catch(console.error);
}

module.exports = { runBenchmarks };
