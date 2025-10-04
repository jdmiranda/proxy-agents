/**
 * Comprehensive Benchmark for pac-resolver optimizations
 *
 * This benchmark tests:
 * 1. PAC script compilation caching
 * 2. FindProxyForURL result memoization
 * 3. DNS resolution caching
 * 4. Overall performance improvement
 */

import { getQuickJS } from '@tootallnate/quickjs-emscripten';
import { createPacResolver } from './src/index';

// Sample PAC file content
const PAC_SCRIPT = `
function FindProxyForURL(url, host) {
    if (isPlainHostName(host) || dnsDomainIs(host, ".local")) {
        return "DIRECT";
    }

    if (shExpMatch(host, "*.example.com")) {
        return "PROXY proxy1.example.com:8080";
    }

    if (isInNet(dnsResolve(host), "192.168.0.0", "255.255.0.0")) {
        return "DIRECT";
    }

    return "PROXY proxy2.example.com:8080; DIRECT";
}
`;

// Test URLs to benchmark
const TEST_URLS = [
    'http://www.google.com/search',
    'http://internal.local/page',
    'http://app.example.com/api',
    'http://192.168.1.100/resource',
    'https://api.github.com/repos',
    'http://www.google.com/search', // Duplicate to test cache
    'http://app.example.com/api', // Duplicate to test cache
];

interface BenchmarkResult {
    test: string;
    iterations: number;
    totalTime: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
}

async function measureTime(fn: () => Promise<void>): Promise<number> {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    return Number(end - start) / 1_000_000; // Convert to milliseconds
}

async function runBenchmark(
    name: string,
    iterations: number,
    fn: () => Promise<void>
): Promise<BenchmarkResult> {
    const times: number[] = [];

    // Warmup
    for (let i = 0; i < 3; i++) {
        await fn();
    }

    // Actual benchmark
    for (let i = 0; i < iterations; i++) {
        const time = await measureTime(fn);
        times.push(time);
    }

    const totalTime = times.reduce((sum, t) => sum + t, 0);
    const avgTime = totalTime / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    return {
        test: name,
        iterations,
        totalTime,
        avgTime,
        minTime,
        maxTime,
    };
}

async function main() {
    console.log('PAC Resolver Performance Benchmark');
    console.log('===================================\n');

    const qjs = await getQuickJS();
    const results: BenchmarkResult[] = [];

    // Benchmark 1: Script compilation (first time)
    console.log('Running Benchmark 1: Script Compilation (first time)...');
    const compileResult = await runBenchmark(
        'Script Compilation',
        10,
        async () => {
            createPacResolver(qjs, PAC_SCRIPT);
        }
    );
    results.push(compileResult);

    // Benchmark 2: Script compilation (cached)
    console.log('Running Benchmark 2: Script Compilation (cached)...');
    const cachedCompileResult = await runBenchmark(
        'Script Compilation (cached)',
        100,
        async () => {
            createPacResolver(qjs, PAC_SCRIPT);
        }
    );
    results.push(cachedCompileResult);

    // Create resolver for subsequent tests
    const findProxyForURL = createPacResolver(qjs, PAC_SCRIPT);

    // Benchmark 3: FindProxyForURL (first time - no cache)
    console.log('Running Benchmark 3: FindProxyForURL (first time)...');
    let urlIndex = 0;
    const firstCallResult = await runBenchmark(
        'FindProxyForURL (first time)',
        TEST_URLS.length,
        async () => {
            await findProxyForURL(TEST_URLS[urlIndex++ % TEST_URLS.length]);
        }
    );
    results.push(firstCallResult);

    // Benchmark 4: FindProxyForURL (cached results)
    console.log('Running Benchmark 4: FindProxyForURL (cached results)...');
    urlIndex = 0;
    const cachedCallResult = await runBenchmark(
        'FindProxyForURL (cached)',
        1000,
        async () => {
            await findProxyForURL(TEST_URLS[urlIndex++ % TEST_URLS.length]);
        }
    );
    results.push(cachedCallResult);

    // Benchmark 5: DNS resolution performance
    console.log('Running Benchmark 5: Sequential URL resolution...');
    const sequentialResult = await runBenchmark(
        'Sequential URL resolution',
        50,
        async () => {
            for (const url of TEST_URLS) {
                await findProxyForURL(url);
            }
        }
    );
    results.push(sequentialResult);

    // Benchmark 6: Parallel URL resolution
    console.log('Running Benchmark 6: Parallel URL resolution...');
    const parallelResult = await runBenchmark(
        'Parallel URL resolution',
        50,
        async () => {
            await Promise.all(TEST_URLS.map(url => findProxyForURL(url)));
        }
    );
    results.push(parallelResult);

    // Print results
    console.log('\n\nBenchmark Results');
    console.log('=================\n');

    for (const result of results) {
        console.log(`Test: ${result.test}`);
        console.log(`  Iterations: ${result.iterations}`);
        console.log(`  Total Time: ${result.totalTime.toFixed(2)} ms`);
        console.log(`  Average Time: ${result.avgTime.toFixed(4)} ms`);
        console.log(`  Min Time: ${result.minTime.toFixed(4)} ms`);
        console.log(`  Max Time: ${result.maxTime.toFixed(4)} ms`);
        console.log('');
    }

    // Calculate performance improvements
    console.log('Performance Improvements');
    console.log('========================\n');

    const compileImprovement = (
        (compileResult.avgTime - cachedCompileResult.avgTime) /
        compileResult.avgTime * 100
    );
    console.log(`Script Compilation Cache: ${compileImprovement.toFixed(2)}% faster`);

    const resultCacheImprovement = (
        (firstCallResult.avgTime - cachedCallResult.avgTime) /
        firstCallResult.avgTime * 100
    );
    console.log(`Result Memoization Cache: ${resultCacheImprovement.toFixed(2)}% faster`);

    const sequentialVsParallel = (
        (sequentialResult.avgTime - parallelResult.avgTime) /
        sequentialResult.avgTime * 100
    );
    console.log(`Parallel vs Sequential: ${sequentialVsParallel.toFixed(2)}% faster`);

    console.log('\nBenchmark completed successfully!');
    process.exit(0);
}

main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});
