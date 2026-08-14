'use strict';

/**
 * Round-12 regression: non-spreading Math.max / Math.min for large arrays.
 *
 * Several renderers compute a width with `Math.max(...arr)` (spread). When the
 * array exceeds V8's argument-stack limit (~1.3e5 elements) the spread throws
 * `RangeError: Maximum call stack size exceeded` — a hard, uncaught crash of the
 * render pass, reachable on pathological model output (a ~130 000-line fenced
 * block, a ~130 000-row table, a mermaid pie/gantt with that many entries).
 *
 * safeArrayMinMax.maxOf / minOf fold with a plain loop: numerically identical to
 * the spread for every non-crashing input, but never overflow the arg stack.
 * Gate KHY_SAFE_ARRAY_MINMAX (default on); off → legacy spread (byte-identical
 * output, but crashes on huge arrays — the load-bearing difference).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LEAF = path.join(__dirname, '..', 'src', 'cli', 'safeArrayMinMax.js');

function load(gate) {
  delete require.cache[require.resolve(LEAF)];
  if (gate === undefined) delete process.env.KHY_SAFE_ARRAY_MINMAX;
  else process.env.KHY_SAFE_ARRAY_MINMAX = gate;
  return require(LEAF);
}

test.afterEach(() => { delete process.env.KHY_SAFE_ARRAY_MINMAX; });

test('maxOf matches Math.max spread on small arrays', () => {
  const { maxOf } = load(undefined);
  assert.strictEqual(maxOf([3, 1, 2]), Math.max(...[3, 1, 2]));
  assert.strictEqual(maxOf([-5, -1, -9]), Math.max(...[-5, -1, -9]));
  assert.strictEqual(maxOf([42]), 42);
});

test('minOf matches Math.min spread on small arrays', () => {
  const { minOf } = load(undefined);
  assert.strictEqual(minOf([3, 1, 2]), Math.min(...[3, 1, 2]));
  assert.strictEqual(minOf([-5, -1, -9]), Math.min(...[-5, -1, -9]));
  assert.strictEqual(minOf([42]), 42);
});

test('floors / ceils fold in like Math.max(20, ...arr)', () => {
  const { maxOf, minOf } = load(undefined);
  assert.strictEqual(maxOf([3, 1, 2], 20), Math.max(20, ...[3, 1, 2]));
  assert.strictEqual(maxOf([3, 1, 2], 1), 3);
  assert.strictEqual(minOf([5, 9], 0), Math.min(0, ...[5, 9]));
  assert.strictEqual(minOf([5, 9], 100), 5);
});

test('empty input returns ±Infinity like the spread', () => {
  const { maxOf, minOf } = load(undefined);
  assert.strictEqual(maxOf([]), -Infinity);
  assert.strictEqual(minOf([]), Infinity);
  // empty values but a floor/ceil present
  assert.strictEqual(maxOf([], 20), 20);
  assert.strictEqual(minOf([], 20), 20);
});

test('NaN propagates exactly as Math.max / Math.min would', () => {
  const { maxOf, minOf } = load(undefined);
  assert.ok(Number.isNaN(maxOf([1, NaN, 2])));
  assert.ok(Number.isNaN(minOf([1, NaN, 2])));
  assert.ok(Number.isNaN(maxOf([1, 2], NaN)));
  assert.ok(Number.isNaN(minOf([1, 2], NaN)));
});

test('accepts any iterable, not just arrays (e.g. Map.values())', () => {
  const { maxOf } = load(undefined);
  const m = new Map([['a', 3], ['b', 7], ['c', 1]]);
  assert.strictEqual(maxOf(m.values(), 0), 7);
});

test('folds a 200k-element array without throwing (the crash class)', () => {
  const { maxOf, minOf } = load(undefined);
  const big = new Array(200000).fill(0).map((_, i) => i % 7);
  assert.strictEqual(maxOf(big, 20), 20);
  assert.strictEqual(maxOf(big), 6);
  assert.strictEqual(minOf(big), 0);
});

test('gate disabled reproduces the legacy spread RangeError (load-bearing)', () => {
  const { maxOf, minOf } = load('0');
  const big = new Array(200000).fill(1);
  assert.throws(() => maxOf(big), RangeError);
  assert.throws(() => minOf(big), RangeError);
});

test('gate disabled is byte-identical on small inputs', () => {
  const on = load(undefined);
  const off = load('0');
  const arr = [4, 8, 15, 16, 23, 42];
  assert.strictEqual(on.maxOf(arr, 20), off.maxOf(arr, 20));
  assert.strictEqual(on.minOf(arr, 0), off.minOf(arr, 0));
});

test('disable-token variants all turn the gate off', () => {
  for (const tok of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    const m = load(tok);
    assert.strictEqual(m.safeArrayMinMaxEnabled(), false, `token ${tok}`);
  }
  assert.strictEqual(load(undefined).safeArrayMinMaxEnabled(), true);
  assert.strictEqual(load('1').safeArrayMinMaxEnabled(), true);
});
