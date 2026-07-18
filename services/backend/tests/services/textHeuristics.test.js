'use strict';

/**
 * textHeuristics.test.js — locks the pure text-heuristic leaf extraction.
 *
 * estimateTokens + isGreeting were sunk out of the 1900-line khyUpgradeRuntime
 * into a zero-dependency leaf to detach inputSanitizer from the giant SCC
 * (DESIGN-ARCH-051 §6.9). These locks pin: (1) estimateTokens golden behavior
 * (contextWasm-or-len/4, empty→0), (2) isGreeting recognition + rejection,
 * (3) khyUpgradeRuntime re-export parity (host export face unchanged), and
 * (4) the leaf carries no SCC-internal require beyond the optional contextWasm
 * delegate (phantom-edge guard, §6.2).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const th = require('../../src/services/textHeuristics');
const runtime = require('../../src/services/khyUpgradeRuntime');

test('estimateTokens: empty/falsy → 0', () => {
  assert.strictEqual(th.estimateTokens(''), 0);
  assert.strictEqual(th.estimateTokens(null), 0);
  assert.strictEqual(th.estimateTokens(undefined), 0);
});

test('estimateTokens: positive integer for non-empty text', () => {
  const n = th.estimateTokens('hello world, this is a token estimate test');
  assert.ok(Number.isInteger(n) && n > 0, `expected positive integer, got ${n}`);
});

test('isGreeting: recognizes Chinese + English greetings', () => {
  for (const g of ['你好', '您好', '早上好', 'hi', 'hello', 'HEY', 'good morning']) {
    assert.strictEqual(th.isGreeting(g), true, `should greet: ${g}`);
  }
});

test('isGreeting: rejects non-greetings, code, paths, and over-long input', () => {
  assert.strictEqual(th.isGreeting('explain this code'), false);
  assert.strictEqual(th.isGreeting('cat /etc/passwd'), false);
  assert.strictEqual(th.isGreeting('`rm -rf`'), false);
  assert.strictEqual(th.isGreeting('x'.repeat(25)), false);
  assert.strictEqual(th.isGreeting(''), false);
  assert.strictEqual(th.isGreeting('   '), false);
});

test('khyUpgradeRuntime re-exports parity (host export face unchanged)', () => {
  assert.strictEqual(runtime.estimateTokens('parity check string'),
    th.estimateTokens('parity check string'));
  assert.strictEqual(runtime.isGreeting('你好'), th.isGreeting('你好'));
  assert.strictEqual(runtime.isGreeting('not a greeting at all'),
    th.isGreeting('not a greeting at all'));
});

test('phantom-edge guard: leaf has no SCC-internal require beyond contextWasm', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/services/textHeuristics.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  assert.deepStrictEqual(requires, ['./contextWasm'],
    `leaf must only require the optional contextWasm delegate, got: ${requires.join(', ')}`);
});
