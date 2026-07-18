'use strict';

/**
 * Regression test for the groundTruth rational-magnitude DoS guard.
 *
 * Defect (REAL, user-reachable P1 freeze): detectComputableClaims(userMessage)
 * runs on raw chat text (ai.js:4703 routeGroundTruth({text: userMessage}),
 * KHY_GROUND_TRUTH default ON). _pow has a 6000-digit cap, but bare
 * multiplication chains — term() -> _mul -> _rat — had NO magnitude guard.
 * A pasted string like "99999*99999*...*99999" (thousands of terms) makes the
 * BigInt product grow without bound; single-threaded multiplication blocks the
 * event loop. Measured: 2000 terms of a 5000-digit literal froze ~103s;
 * 999999999 x100000 froze ~11s. The call site's try/catch does NOT save it
 * (freeze, not throw).
 *
 * Fix: cap |numerator| and denominator to ~6000 decimal digits inside _rat
 * (the single funnel for _add/_sub/_mul/_div), aligned with _POW_DIGIT_LIMIT.
 * Gated by KHY_GROUND_TRUTH_RAT_GUARD (default on); off = legacy unbounded.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const gt = require(path.resolve(__dirname, '../src/services/groundTruth.js'));

function withGuard(value, fn) {
  const prev = process.env.KHY_GROUND_TRUTH_RAT_GUARD;
  if (value === undefined) delete process.env.KHY_GROUND_TRUTH_RAT_GUARD;
  else process.env.KHY_GROUND_TRUTH_RAT_GUARD = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.KHY_GROUND_TRUTH_RAT_GUARD;
    else process.env.KHY_GROUND_TRUTH_RAT_GUARD = prev;
  }
}

test('guard ON: long multiplication chain does not freeze', () => {
  const expr = Array(100000).fill('999999999').join('*');
  const t = Date.now();
  const facts = gt.detectComputableClaims(expr);
  const ms = Date.now() - t;
  assert.ok(ms < 2000, `expected <2000ms, got ${ms}ms`);
  // Astronomical result is correctly skipped (over the digit cap → no fact).
  assert.strictEqual(facts.length, 0);
});

test('guard ON: chain of huge literals does not freeze', () => {
  const expr = Array(2000).fill('9'.repeat(5000)).join('*');
  const t = Date.now();
  const facts = gt.detectComputableClaims(expr);
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `expected <3000ms, got ${ms}ms`);
  assert.strictEqual(facts.length, 0);
});

test('guard ON: normal arithmetic still computes exactly', () => {
  const cases = [
    ['compute 2+2', '4'],
    ['compute 123*456', '56088'],
    ['compute 2^10', '1024'],
    ['compute 999*999', '998001'],
    ['compute 1024*1024*1024', '1073741824'],
  ];
  for (const [msg, expected] of cases) {
    const facts = gt.detectComputableClaims(msg);
    assert.ok(facts.length >= 1, `no fact for ${msg}`);
    assert.strictEqual(facts[0].value, expected, `wrong value for ${msg}: ${facts[0].value}`);
  }
});

test('guard ON: exact fraction still preserved', () => {
  const facts = gt.detectComputableClaims('compute 100/7');
  assert.ok(facts.length >= 1);
  assert.strictEqual(facts[0].value, '100/7');
});

test('guard ON vs OFF: identical for valid (under-limit) computations', () => {
  const msgs = [
    'compute 12345678*87654321',
    'compute 2^100',
    'compute 999999*999999',
    'compute 3.14*2',
    'no math here just prose',
  ];
  for (const msg of msgs) {
    const on = JSON.stringify(withGuard('1', () => gt.detectComputableClaims(msg)));
    const off = JSON.stringify(withGuard('0', () => gt.detectComputableClaims(msg)));
    assert.strictEqual(on, off, `mismatch for ${msg}`);
  }
});

test('guard OFF reproduces the freeze (load-bearing proof)', () => {
  // Moderate size so the test stays reasonably fast while still demonstrating
  // the blow-up: guard OFF must be dramatically slower than guard ON.
  const expr = Array(800).fill('9'.repeat(3000)).join('*');
  const guardedMs = withGuard('1', () => { const t = Date.now(); gt.detectComputableClaims(expr); return Date.now() - t; });
  const legacyMs = withGuard('0', () => { const t = Date.now(); gt.detectComputableClaims(expr); return Date.now() - t; });
  assert.ok(legacyMs > guardedMs * 5 + 100, `legacy (${legacyMs}ms) not >> guarded (${guardedMs}ms) — guard not load-bearing`);
});

test('guard ON: pow chain and huge exponent stay bounded (pre-existing _pow cap)', () => {
  for (const expr of ['2^2^2^2^999', '9^999999999', '123456789^4096']) {
    const t = Date.now();
    gt.detectComputableClaims(expr);
    assert.ok(Date.now() - t < 1000);
  }
});

test('detectComputableClaims never throws on hostile input', () => {
  for (const bad of [null, undefined, 42, {}, [], '%%%', '\x00'.repeat(100), '9'.repeat(200000) + '*2']) {
    assert.doesNotThrow(() => gt.detectComputableClaims(bad));
  }
});
