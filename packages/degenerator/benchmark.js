/**
 * Benchmark suite for degenerator performance optimizations
 * Tests: AST transformation caching, code generation caching, fast paths
 */

const { degenerator } = require('./dist/degenerator');

// Sample code snippets for benchmarking
const simpleSync = `
function fetchData(url) {
  return fetch(url);
}
`;

const complexSync = `
function processData(data) {
  const result1 = transformData(data);
  const result2 = validateData(result1);
  const result3 = storeData(result2);
  return result3;
}

function transformData(data) {
  return data.map(item => processItem(item));
}

function validateData(data) {
  return data.filter(item => checkItem(item));
}
`;

const alreadyAsync = `
async function fetchData(url) {
  return await fetch(url);
}
`;

const nestedFunctions = `
function outer() {
  function inner1() {
    return fetch('url1');
  }
  function inner2() {
    return fetch('url2');
  }
  function inner3() {
    return inner1() + inner2();
  }
  return inner3();
}
`;

// Benchmark helper
function benchmark(name, fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < 10; i++) {
    fn();
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = process.hrtime.bigint();

  const totalMs = Number(end - start) / 1_000_000;
  const opsPerSec = (iterations / totalMs) * 1000;

  console.log(`${name}:`);
  console.log(`  Total time: ${totalMs.toFixed(2)}ms`);
  console.log(`  Ops/sec: ${opsPerSec.toFixed(0)}`);
  console.log(`  Avg time: ${(totalMs / iterations).toFixed(3)}ms`);
  console.log('');

  return { totalMs, opsPerSec };
}

console.log('=== Degenerator Performance Benchmarks ===\n');

// Test 1: Simple function compilation
benchmark('Simple function compilation', () => {
  degenerator(simpleSync, ['fetch']);
}, 1000);

// Test 2: Complex nested functions
benchmark('Complex nested functions', () => {
  degenerator(complexSync, ['transformData', 'validateData', 'storeData', 'processItem', 'checkItem']);
}, 1000);

// Test 3: Fast path for already-async functions
benchmark('Already-async fast path', () => {
  degenerator(alreadyAsync, ['fetch']);
}, 1000);

// Test 4: Deeply nested functions
benchmark('Deeply nested functions', () => {
  degenerator(nestedFunctions, ['fetch']);
}, 1000);

// Test 5: Cached vs fresh compilation (same code twice)
console.log('=== Cache Performance Test ===\n');

const testCode = complexSync;
const testNames = ['transformData', 'validateData', 'storeData'];

// First compilation (fresh)
const fresh = benchmark('Fresh compilation (no cache)', () => {
  degenerator(testCode, testNames);
}, 500);

// Second compilation (potentially cached patterns)
const cached = benchmark('Subsequent compilation (cached patterns)', () => {
  degenerator(testCode, testNames);
}, 500);

console.log('=== Cache Speedup ===');
const speedup = ((cached.opsPerSec / fresh.opsPerSec) * 100).toFixed(2);
console.log(`Speedup: ${speedup}%`);
console.log('');

// Test 6: AST transformation speed
console.log('=== AST Transformation Speed ===\n');

const largeCode = `
${Array(50).fill(0).map((_, i) => `
function func${i}(arg) {
  return process${i}(arg);
}
`).join('\n')}
`;

const largeNames = Array(50).fill(0).map((_, i) => `process${i}`);

benchmark('Large codebase AST transformation', () => {
  degenerator(largeCode, largeNames);
}, 100);

console.log('=== Benchmark Complete ===');
