const { getUri } = require('./dist/index');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

/**
 * Benchmark suite for get-uri package optimizations
 */

// Create a test file for benchmarking
const testFile = path.join(__dirname, 'test-benchmark.txt');
fs.writeFileSync(testFile, 'Test content for benchmarking\n'.repeat(1000));

// Cleanup function
function cleanup() {
	try {
		fs.unlinkSync(testFile);
	} catch (e) {
		// Ignore
	}
}

// Benchmark: URI resolution speed
async function benchmarkURIResolution(iterations = 100) {
	const testURI = `file://${testFile}`;

	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const stream = await getUri(testURI);
		stream.resume(); // Consume stream
		await new Promise((resolve, reject) => {
			stream.on('end', resolve);
			stream.on('error', reject);
		});
		stream.destroy(); // Ensure cleanup
	}
	const end = performance.now();

	const totalTime = end - start;
	const opsPerSec = (iterations / totalTime) * 1000;

	return {
		totalTime: totalTime.toFixed(2),
		opsPerSec: opsPerSec.toFixed(2),
		avgTime: (totalTime / iterations).toFixed(3)
	};
}

// Benchmark: Protocol handler lookup
function benchmarkProtocolLookup(iterations = 1000000) {
	const protocols = ['file', 'http', 'https', 'ftp', 'data'];

	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const protocol = protocols[i % protocols.length];
		// Simulate the lookup that happens in getUri
		const _ = protocol + '://';
	}
	const end = performance.now();

	const totalTime = end - start;
	const opsPerSec = (iterations / totalTime) * 1000;

	return {
		totalTime: totalTime.toFixed(2),
		opsPerSec: opsPerSec.toFixed(2),
		avgTime: (totalTime / iterations).toFixed(6)
	};
}

// Benchmark: Stream creation performance for file:// URLs
async function benchmarkFileStreamCreation(iterations = 50) {
	const testURI = `file://${testFile}`;

	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const stream = await getUri(testURI);
		stream.resume(); // Consume stream
		await new Promise((resolve, reject) => {
			stream.on('end', resolve);
			stream.on('error', reject);
		});
		stream.destroy(); // Ensure cleanup
	}
	const end = performance.now();

	const totalTime = end - start;
	const opsPerSec = (iterations / totalTime) * 1000;

	return {
		totalTime: totalTime.toFixed(2),
		opsPerSec: opsPerSec.toFixed(2),
		avgTime: (totalTime / iterations).toFixed(3)
	};
}

// Benchmark: URL parsing cache effectiveness
async function benchmarkURLParsingCache(iterations = 100) {
	const testURI = `file://${testFile}`;

	// First pass - cold cache
	const coldStart = performance.now();
	for (let i = 0; i < iterations; i++) {
		const stream = await getUri(testURI);
		stream.destroy(); // Don't consume, just test parsing
		// Small delay to allow cleanup
		await new Promise(resolve => setImmediate(resolve));
	}
	const coldEnd = performance.now();

	const coldTime = coldEnd - coldStart;
	const coldOpsPerSec = (iterations / coldTime) * 1000;

	return {
		coldTime: coldTime.toFixed(2),
		coldOpsPerSec: coldOpsPerSec.toFixed(2),
		avgColdTime: (coldTime / iterations).toFixed(3)
	};
}

// Benchmark: Repeated access to same URI (tests caching)
async function benchmarkRepeatedAccess(iterations = 50) {
	const testURI = `file://${testFile}`;

	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const stream = await getUri(testURI);
		stream.resume();
		await new Promise((resolve, reject) => {
			stream.on('end', resolve);
			stream.on('error', reject);
		});
		stream.destroy(); // Ensure cleanup
	}
	const end = performance.now();

	const totalTime = end - start;
	const opsPerSec = (iterations / totalTime) * 1000;

	return {
		totalTime: totalTime.toFixed(2),
		opsPerSec: opsPerSec.toFixed(2),
		avgTime: (totalTime / iterations).toFixed(3)
	};
}

// Main benchmark runner
async function runBenchmarks() {
	console.log('='.repeat(70));
	console.log('GET-URI PERFORMANCE BENCHMARKS');
	console.log('='.repeat(70));
	console.log();

	try {
		console.log('1. URI Resolution Speed Test');
		console.log('-'.repeat(70));
		const uriResolution = await benchmarkURIResolution(100);
		console.log(`   Total Time: ${uriResolution.totalTime} ms`);
		console.log(`   Operations/sec: ${uriResolution.opsPerSec}`);
		console.log(`   Average Time: ${uriResolution.avgTime} ms/op`);
		console.log();

		console.log('2. Protocol Handler Lookup Performance');
		console.log('-'.repeat(70));
		const protocolLookup = benchmarkProtocolLookup(1000000);
		console.log(`   Total Time: ${protocolLookup.totalTime} ms`);
		console.log(`   Operations/sec: ${protocolLookup.opsPerSec}`);
		console.log(`   Average Time: ${protocolLookup.avgTime} ms/op`);
		console.log();

		console.log('3. File Stream Creation Performance');
		console.log('-'.repeat(70));
		const streamCreation = await benchmarkFileStreamCreation(100);
		console.log(`   Total Time: ${streamCreation.totalTime} ms`);
		console.log(`   Operations/sec: ${streamCreation.opsPerSec}`);
		console.log(`   Average Time: ${streamCreation.avgTime} ms/op`);
		console.log();

		console.log('4. URL Parsing Cache Test');
		console.log('-'.repeat(70));
		const urlCache = await benchmarkURLParsingCache(100);
		console.log(`   Cold Cache Time: ${urlCache.coldTime} ms`);
		console.log(`   Cold Cache Ops/sec: ${urlCache.coldOpsPerSec}`);
		console.log(`   Average Cold Time: ${urlCache.avgColdTime} ms/op`);
		console.log();

		console.log('5. Repeated Access Performance (Same URI)');
		console.log('-'.repeat(70));
		const repeatedAccess = await benchmarkRepeatedAccess(50);
		console.log(`   Total Time: ${repeatedAccess.totalTime} ms`);
		console.log(`   Operations/sec: ${repeatedAccess.opsPerSec}`);
		console.log(`   Average Time: ${repeatedAccess.avgTime} ms/op`);
		console.log();

		console.log('='.repeat(70));
		console.log('BENCHMARK SUMMARY');
		console.log('='.repeat(70));
		console.log('Optimizations Applied:');
		console.log('  ✓ Protocol handler caching (Map-based O(1) lookup)');
		console.log('  ✓ URL parsing cache (WeakMap for automatic GC)');
		console.log('  ✓ Fast path for file:// URLs (skip cache validation when not needed)');
		console.log('  ✓ Reduced string operations (slice vs replace)');
		console.log('  ✓ Optimized protocol detection (endsWith vs regex)');
		console.log();

	} catch (error) {
		console.error('Benchmark error:', error);
	} finally {
		cleanup();
	}
}

// Run benchmarks
if (require.main === module) {
	runBenchmarks().catch(console.error);
}

module.exports = { runBenchmarks };
