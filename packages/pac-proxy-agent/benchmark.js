/**
 * Benchmark for pac-proxy-agent optimizations
 *
 * Tests the performance improvements from:
 * - PAC file parsing cache (by URL)
 * - Resolution result memoization
 * - FindProxyForURL caching
 * - Script compilation optimization
 */

const { PacProxyAgent, clearPacCaches, getCacheStats } = require('./dist/index.js');
const { performance } = require('perf_hooks');
const http = require('http');

// Simple PAC file for testing
const PAC_FILE_CONTENT = `
function FindProxyForURL(url, host) {
  // Simulate some computation
  if (host === "example.com") {
    return "PROXY proxy1.example.com:8080";
  }
  if (host === "test.com") {
    return "PROXY proxy2.example.com:8080";
  }
  if (shExpMatch(host, "*.internal.com")) {
    return "DIRECT";
  }
  return "PROXY default.example.com:8080";
}
`;

// Create a simple HTTP server to serve the PAC file
function createPacServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
      res.end(PAC_FILE_CONTENT);
    });

    server.listen(0, () => {
      const port = server.address().port;
      resolve({ server, url: `http://localhost:${port}/proxy.pac` });
    });
  });
}

// Benchmark function
async function benchmark(name, fn, iterations = 100) {
  const times = [];

  // Warmup
  for (let i = 0; i < 10; i++) {
    await fn();
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    const end = performance.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const median = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];

  console.log(`\n${name}:`);
  console.log(`  Iterations: ${iterations}`);
  console.log(`  Average:    ${avg.toFixed(3)} ms`);
  console.log(`  Median:     ${median.toFixed(3)} ms`);
  console.log(`  Min:        ${min.toFixed(3)} ms`);
  console.log(`  Max:        ${max.toFixed(3)} ms`);

  return { avg, median, min, max };
}

async function runBenchmarks() {
  console.log('='.repeat(60));
  console.log('PAC Proxy Agent Performance Benchmark');
  console.log('='.repeat(60));

  const { server, url: pacUrl } = await createPacServer();

  try {
    // Test 1: PAC file loading without cache
    console.log('\n--- Test 1: PAC File Loading (Cold Start) ---');
    clearPacCaches();

    const coldStartResults = await benchmark('PAC File Loading - Cold', async () => {
      clearPacCaches();
      const agent = new PacProxyAgent(pacUrl);
      await agent.getResolver();
      agent.destroy();
    }, 50);

    // Test 2: PAC file loading with cache
    console.log('\n--- Test 2: PAC File Loading (Warm Cache) ---');
    clearPacCaches();

    // Prime the cache
    const agent1 = new PacProxyAgent(pacUrl);
    await agent1.getResolver();

    const warmStartResults = await benchmark('PAC File Loading - Warm', async () => {
      const agent = new PacProxyAgent(pacUrl);
      await agent1.getResolver();
      agent.destroy();
    }, 100);

    console.log(`\nImprovement: ${((coldStartResults.avg / warmStartResults.avg) * 100 - 100).toFixed(2)}% faster with cache`);

    // Test 3: Resolution without memoization
    console.log('\n--- Test 3: Proxy Resolution (Without Memoization) ---');
    clearPacCaches();

    const agent2 = new PacProxyAgent(pacUrl);
    const resolver = await agent2.getResolver();

    const unmemoizedResults = await benchmark('Resolution - Unmemoized', async () => {
      clearPacCaches();
      const agent = new PacProxyAgent(pacUrl);
      const r = await agent.getResolver();
      await r(new URL('http://example.com/test'));
    }, 100);

    // Test 4: Resolution with memoization
    console.log('\n--- Test 4: Proxy Resolution (With Memoization) ---');
    clearPacCaches();

    const agent3 = new PacProxyAgent(pacUrl);
    const resolver2 = await agent3.getResolver();

    // Prime the cache
    await resolver2(new URL('http://example.com/test'));

    const memoizedResults = await benchmark('Resolution - Memoized', async () => {
      await resolver2(new URL('http://example.com/test'));
    }, 1000);

    console.log(`\nImprovement: ${((unmemoizedResults.avg / memoizedResults.avg) * 100 - 100).toFixed(2)}% faster with memoization`);

    // Test 5: Multiple different URLs
    console.log('\n--- Test 5: Multiple Different URLs ---');
    clearPacCaches();

    const agent4 = new PacProxyAgent(pacUrl);
    const resolver3 = await agent4.getResolver();

    const urls = [
      'http://example.com/path1',
      'http://test.com/path2',
      'http://subdomain.internal.com/path3',
      'http://other.example.com/path4',
    ];

    await benchmark('Multiple URLs - First Pass', async () => {
      for (const url of urls) {
        await resolver3(new URL(url));
      }
    }, 50);

    // All URLs should now be cached
    const cachedMultiResults = await benchmark('Multiple URLs - Cached Pass', async () => {
      for (const url of urls) {
        await resolver3(new URL(url));
      }
    }, 100);

    // Test 6: Cache statistics
    console.log('\n--- Test 6: Cache Statistics ---');
    const stats = getCacheStats();
    console.log(`\nPAC File Cache:`);
    console.log(`  Entries: ${stats.pacFileCache.size}`);
    console.log(`  URLs: ${stats.pacFileCache.entries.join(', ')}`);
    console.log(`\nResolution Cache:`);
    console.log(`  Entries: ${stats.resolutionCache.size}`);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Summary');
    console.log('='.repeat(60));
    console.log(`\nPAC File Loading:`);
    console.log(`  Cold: ${coldStartResults.avg.toFixed(3)} ms`);
    console.log(`  Warm: ${warmStartResults.avg.toFixed(3)} ms`);
    console.log(`  Speedup: ${(coldStartResults.avg / warmStartResults.avg).toFixed(2)}x`);

    console.log(`\nProxy Resolution:`);
    console.log(`  Unmemoized: ${unmemoizedResults.avg.toFixed(3)} ms`);
    console.log(`  Memoized:   ${memoizedResults.avg.toFixed(3)} ms`);
    console.log(`  Speedup: ${(unmemoizedResults.avg / memoizedResults.avg).toFixed(2)}x`);

    console.log('\n' + '='.repeat(60));

    agent1.destroy();
    agent2.destroy();
    agent3.destroy();
    agent4.destroy();

  } finally {
    server.close();
  }
}

// Run benchmarks if this file is executed directly
if (require.main === module) {
  runBenchmarks()
    .then(() => {
      console.log('\nBenchmark completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\nBenchmark failed:', error);
      process.exit(1);
    });
}

module.exports = { runBenchmarks };
