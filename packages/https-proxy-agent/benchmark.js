const { HttpsProxyAgent } = require('.');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Configuration
const BENCHMARK_ITERATIONS = 100;
const WARMUP_ITERATIONS = 10;

// Simple proxy server for testing
let proxyServer;
let targetServer;

function createProxyServer() {
	return new Promise((resolve) => {
		const server = http.createServer();
		server.on('connect', (req, clientSocket, head) => {
			const [host, port] = req.url.split(':');
			const serverSocket = net.connect(port, host, () => {
				clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
				serverSocket.write(head);
				serverSocket.pipe(clientSocket);
				clientSocket.pipe(serverSocket);
			});
			serverSocket.on('error', () => clientSocket.end());
			clientSocket.on('error', () => serverSocket.end());
		});
		server.listen(0, () => {
			resolve(server);
		});
	});
}

function createTargetServer() {
	return new Promise((resolve) => {
		const options = {
			key: fs.readFileSync(path.join(__dirname, 'key.pem')),
			cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
		};

		const server = https.createServer(options);

		server.on('request', (req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/plain' });
			res.end('OK');
		});

		server.listen(0, () => {
			resolve(server);
		});
	});
}

async function measureConnectionSpeed(agent, url, iterations) {
	const times = [];

	for (let i = 0; i < iterations; i++) {
		const start = performance.now();

		await new Promise((resolve, reject) => {
			const req = https.get(url, { agent, rejectUnauthorized: false }, (res) => {
				res.resume();
				res.on('end', () => {
					const end = performance.now();
					times.push(end - start);
					resolve();
				});
			});
			req.on('error', reject);
		});
	}

	return times;
}

function calculateStats(times) {
	const sorted = times.slice().sort((a, b) => a - b);
	const sum = times.reduce((a, b) => a + b, 0);
	const mean = sum / times.length;
	const median = sorted[Math.floor(sorted.length / 2)];
	const min = sorted[0];
	const max = sorted[sorted.length - 1];
	const p95 = sorted[Math.floor(sorted.length * 0.95)];
	const p99 = sorted[Math.floor(sorted.length * 0.99)];

	return { mean, median, min, max, p95, p99 };
}

async function runBenchmarks() {
	console.log('Starting HTTPS Proxy Agent Benchmarks...\n');

	// Create servers
	proxyServer = await createProxyServer();
	targetServer = await createTargetServer();

	const proxyPort = proxyServer.address().port;
	const targetPort = targetServer.address().port;
	const proxyUrl = `http://127.0.0.1:${proxyPort}`;
	const targetUrl = `https://127.0.0.1:${targetPort}`;

	console.log(`Proxy server listening on port ${proxyPort}`);
	console.log(`Target server listening on port ${targetPort}\n`);

	// Create agent with optimizations
	const agent = new HttpsProxyAgent(proxyUrl, {
		keepAlive: true,
		maxSockets: 10,
	});

	console.log('Warming up...');
	await measureConnectionSpeed(agent, targetUrl, WARMUP_ITERATIONS);

	console.log('\n=== HTTPS Proxy Connection Speed ===');
	const connectionTimes = await measureConnectionSpeed(agent, targetUrl, BENCHMARK_ITERATIONS);
	const connStats = calculateStats(connectionTimes);
	console.log(`Iterations: ${BENCHMARK_ITERATIONS}`);
	console.log(`Mean: ${connStats.mean.toFixed(2)}ms`);
	console.log(`Median: ${connStats.median.toFixed(2)}ms`);
	console.log(`Min: ${connStats.min.toFixed(2)}ms`);
	console.log(`Max: ${connStats.max.toFixed(2)}ms`);
	console.log(`P95: ${connStats.p95.toFixed(2)}ms`);
	console.log(`P99: ${connStats.p99.toFixed(2)}ms`);

	console.log('\n=== SSL Session Reuse Effectiveness ===');
	// Measure first connection (full handshake)
	const newAgent1 = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
	const firstConnTime = await measureConnectionSpeed(newAgent1, targetUrl, 1);

	// Measure subsequent connections (with session reuse)
	const subsequentTimes = await measureConnectionSpeed(newAgent1, targetUrl, 10);
	const reuseStats = calculateStats(subsequentTimes);

	console.log(`First connection (full handshake): ${firstConnTime[0].toFixed(2)}ms`);
	console.log(`Subsequent connections (session reuse): ${reuseStats.mean.toFixed(2)}ms (avg)`);
	const improvement = ((firstConnTime[0] - reuseStats.mean) / firstConnTime[0] * 100).toFixed(2);
	console.log(`Session reuse improvement: ${improvement}%`);

	console.log('\n=== TLS Handshake Performance ===');
	// Measure without session caching
	const agentNoCache = new HttpsProxyAgent(proxyUrl, { keepAlive: false });
	const noCacheTimes = await measureConnectionSpeed(agentNoCache, targetUrl, 20);
	const noCacheStats = calculateStats(noCacheTimes);

	// Measure with session caching
	const agentWithCache = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
	const cacheTimes = await measureConnectionSpeed(agentWithCache, targetUrl, 20);
	const cacheStats = calculateStats(cacheTimes);

	console.log(`Without session cache: ${noCacheStats.mean.toFixed(2)}ms (avg)`);
	console.log(`With session cache: ${cacheStats.mean.toFixed(2)}ms (avg)`);
	const cacheImprovement = ((noCacheStats.mean - cacheStats.mean) / noCacheStats.mean * 100).toFixed(2);
	console.log(`Cache improvement: ${cacheImprovement}%`);

	console.log('\n=== Header Caching Performance ===');
	// Measure time with header caching
	const headerCacheTimes = await measureConnectionSpeed(agent, targetUrl, 50);
	const headerCacheStats = calculateStats(headerCacheTimes);
	console.log(`Mean connection time with header cache: ${headerCacheStats.mean.toFixed(2)}ms`);
	console.log(`P95: ${headerCacheStats.p95.toFixed(2)}ms`);

	// Cleanup
	agent.destroy();
	newAgent1.destroy();
	agentNoCache.destroy();
	agentWithCache.destroy();
	proxyServer.close();
	targetServer.close();

	console.log('\nBenchmarks completed successfully!');
}

// Run benchmarks
if (require.main === module) {
	runBenchmarks().catch((err) => {
		console.error('Benchmark failed:', err);
		process.exit(1);
	});
}

module.exports = { runBenchmarks };
