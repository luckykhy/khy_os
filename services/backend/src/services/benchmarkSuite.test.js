'use strict';

/**
 * Tests for benchmarkSuite.js
 *
 * Validates:
 * 1. Benchmark execution
 * 2. Performance assertions
 * 3. Result formatting
 */

const { benchmark, BenchmarkResult } = require('./benchmarkSuite');

// ── Test Helpers ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

// ── Benchmark Tests ───────────────────────────────────────────────────────

async function testBenchmarkExecution() {
  console.log('\n── Benchmark: Execution ──');

  const result = await benchmark('test-op', 100, async () => {
    return 42;
  });

  assert(result instanceof BenchmarkResult, 'returns BenchmarkResult');
  assert(result.name === 'test-op', 'name set correctly');
  assert(result.iterations === 100, 'iterations set correctly');
  assert(result.totalMs > 0, 'total time > 0');
  assert(result.avgMs > 0, 'avg time > 0');
  assert(result.opsPerSecond > 0, 'ops/sec > 0');
}

async function testBenchmarkAccuracy() {
  console.log('\n── Benchmark: Accuracy ──');

  // Measure a known delay
  const result = await benchmark('delay-10ms', 10, async () => {
    await new Promise(r => setTimeout(r, 10));
    return true;
  });

  // Should be at least 10ms total (10 iterations * 10ms)
  assert(result.totalMs >= 50, `total time reasonable (${result.totalMs.toFixed(1)}ms)`);
  assert(result.avgMs >= 5, `avg time reasonable (${result.avgMs.toFixed(2)}ms)`);
}

async function testBenchmarkResult() {
  console.log('\n── BenchmarkResult: Properties ──');

  const result = new BenchmarkResult('test', 1000, 500);

  assert(result.name === 'test', 'name property');
  assert(result.iterations === 1000, 'iterations property');
  assert(result.totalMs === 500, 'totalMs property');
  assert(result.avgMs === 0.5, 'avgMs calculated');
  assert(result.opsPerSecond === 2000, 'opsPerSecond calculated');
}

// ── Run All Tests ─────────────────────────────────────────────────────────

async function runTests() {
  console.log('═══════════════════════════════════════════');
  console.log('  Benchmark Suite Tests');
  console.log('═══════════════════════════════════════════');

  await testBenchmarkExecution();
  await testBenchmarkAccuracy();
  await testBenchmarkResult();

  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
