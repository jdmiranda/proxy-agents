const http = require('http');
const { Agent } = require('./dist/index.js');

// Simple benchmark agent
class BenchmarkAgent extends Agent {
	connect(req, opts) {
		// Simulate a fast synchronous connection
		const socket = new require('net').Socket();
		socket.destroyed = false;
		return socket;
	}
}

function benchmark(name, fn, iterations = 10000) {
	const start = process.hrtime.bigint();
	for (let i = 0; i < iterations; i++) {
		fn();
	}
	const end = process.hrtime.bigint();
	const duration = Number(end - start) / 1_000_000; // Convert to milliseconds
	const opsPerSec = (iterations / duration) * 1000;

	console.log(`${name}:`);
	console.log(`  Total: ${duration.toFixed(2)}ms`);
	console.log(`  Ops/sec: ${opsPerSec.toFixed(0)}`);
	console.log(`  Avg: ${(duration / iterations).toFixed(4)}ms\n`);

	return { duration, opsPerSec };
}

console.log('=== Agent-Base Performance Benchmark ===\n');

// Benchmark 1: isSecureEndpoint with protocol
const agent1 = new BenchmarkAgent();
const opts1 = { protocol: 'https:', port: 443, host: 'example.com' };
benchmark('isSecureEndpoint (with protocol)', () => {
	agent1.isSecureEndpoint(opts1);
});

// Benchmark 2: isSecureEndpoint with explicit secureEndpoint
const agent2 = new BenchmarkAgent();
const opts2 = { secureEndpoint: true, port: 443, host: 'example.com' };
benchmark('isSecureEndpoint (with secureEndpoint)', () => {
	agent2.isSecureEndpoint(opts2);
});

// Benchmark 3: getName operations
const agent3 = new BenchmarkAgent();
const opts3 = { protocol: 'https:', port: 443, host: 'example.com', secureEndpoint: true };
benchmark('getName (https)', () => {
	agent3.getName(opts3);
});

// Benchmark 4: incrementSockets/decrementSockets with no limits
const agent4 = new BenchmarkAgent({ maxSockets: Infinity, maxTotalSockets: Infinity });
benchmark('incrementSockets (no limits)', () => {
	agent4['incrementSockets']('test:80');
});

// Benchmark 5: incrementSockets/decrementSockets with limits
const agent5 = new BenchmarkAgent({ maxSockets: 10 });
let counter = 0;
benchmark('incrementSockets (with limits)', () => {
	const name = `test${counter++}:80`;
	const fakeSocket = agent5['incrementSockets'](name);
	agent5['decrementSockets'](name, fakeSocket);
}, 1000);

console.log('=== Benchmark Complete ===');
console.log('\nOptimizations applied:');
console.log('  ✓ Cached isSecureEndpoint results');
console.log('  ✓ Optimized stack trace analysis');
console.log('  ✓ Reduced object spread overhead');
console.log('  ✓ Added fast path for synchronous connections');
console.log('  ✓ Reduced property access overhead');
