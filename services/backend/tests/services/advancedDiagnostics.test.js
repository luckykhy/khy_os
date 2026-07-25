'use strict';

/**
 * advancedDiagnostics SlidingWindowMetric.getP95 — nearest-rank percentile.
 *
 * Regression: getP95 used `Math.floor(sorted.length * 0.95)`, which overshoots
 * the nearest-rank 95th percentile by one index whenever 0.95·n is an integer
 * (n a multiple of 20). For exactly 20 samples it returned the MAXIMUM (P100)
 * instead of the 19th value; for 100 samples the 96th instead of the 95th.
 * The fix uses `Math.ceil(sorted.length * 0.95) - 1`, matching the codebase's
 * other percentile helper (usageTracker._percentile). For every sample count
 * that is not a multiple of 20, floor == ceil-1, so output is byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const { SlidingWindowMetric } = require('../../src/services/advancedDiagnostics');

// Build a metric with a window so large nothing evicts, push values 1..n (so
// the sorted array is [1..n] and sorted[idx] === idx + 1), and read getP95.
function p95(n) {
  const m = new SlidingWindowMetric(1e12);
  for (let i = 1; i <= n; i++) m.add(i);
  return m.getP95();
}

// Nearest-rank reference: 0-based index ceil(0.95·n)-1, clamped, +1 to recover
// the value (since values are 1..n).
function ref(n) {
  return Math.max(0, Math.min(Math.ceil(n * 0.95) - 1, n - 1)) + 1;
}

test('getP95 of exactly 20 samples is the 19th value, not the maximum', () => {
  // Old floor(0.95*20)=19 returned sorted[19] = 20 (the max / P100). Correct P95
  // by nearest-rank is sorted[18] = 19.
  assert.strictEqual(p95(20), 19);
});

test('getP95 of 100 samples is the 95th value, not the 96th', () => {
  assert.strictEqual(p95(100), 95);
});

test('getP95 matches the nearest-rank reference for n = 1..200', () => {
  for (let n = 1; n <= 200; n++) {
    assert.strictEqual(p95(n), ref(n), `mismatch at n=${n}`);
  }
});

test('getP95 is unchanged for sample counts that are not multiples of 20', () => {
  // These are the cases where floor(0.95*n) already equalled ceil(0.95*n)-1,
  // so the fix must leave them byte-identical.
  assert.strictEqual(p95(10), 10);
  assert.strictEqual(p95(21), 20);
  assert.strictEqual(p95(37), 36);
  assert.strictEqual(p95(99), 95);
  assert.strictEqual(p95(1), 1);
});

test('getP95 of an empty window is 0', () => {
  assert.strictEqual(new SlidingWindowMetric(1e12).getP95(), 0);
});
