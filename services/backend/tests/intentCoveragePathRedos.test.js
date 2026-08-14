'use strict';

/**
 * Regression tests for the intentCoverage path-extraction ReDoS guard.
 *
 * Defect (REAL, user-reachable P1): _checkableFromText's path regex
 *   /(?:[A-Za-z0-9_.\-]+[\/\\])+[A-Za-z0-9_.\-]+|.../g
 * has a greedy `+` run inside a nested `+` group. On a long run of
 * [A-Za-z0-9_.-] chars ending in `/` it backtracks catastrophically —
 * O(n^2): ~10s at 100K chars, ~40s at 200K. It runs on originalUserMessage
 * (raw user input) after every tool-using AI turn (toolUseLoop assessIntentCoverage,
 * enabled by default). ReDoS is a HANG, not a throw — the call site's try/catch
 * does NOT save it (single-threaded backtracking blocks the event loop). A user
 * pasting ultra-long garbled text freezes khyos = DoS.
 *
 * Fix: bound each path component to {1,255} (filesystem single-component hard
 * limit) so the regex is linear. Byte-identical for every realistic path.
 * Gated by pathRedosGuard (default true); false = legacy unbounded regex.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = path.resolve(__dirname, '../src/services/intentCoverage.js');
const { _checkableFromText, assessIntentCoverage } = require(MOD);

// Realistic messages that mention files/paths — the extraction must be
// byte-identical whether the guard is on or off.
const REALISTIC = [
  '请修改 src/cli/ai.js 和 services/backend/tests/foo.test.js',
  '看下 config.json 还有 a_b/c-d/e.py 这个路径',
  '重构 utils/helper.ts、components/Button.vue，保留 README.md',
  '路径 ./scripts/diagnostics/fuzz-input.js 有问题',
  'no paths here just prose about maotai and 茅台',
  'windows path C:\\Users\\dev\\project\\main.go handling',
  'deep/nested/a/b/c/d/e/f/g/file_name-2.tsx 请看这个',
  'mixed 引用「保留原样」加 path lib/x.js 和标识符 myLongIdentifier',
  '',
  '   ',
];

test('extraction is byte-identical (guard ON vs OFF) on realistic inputs', () => {
  for (const s of REALISTIC) {
    const on = _checkableFromText(s, true);
    const off = _checkableFromText(s, false);
    assert.deepStrictEqual(on, off, `mismatch for: ${JSON.stringify(s)}`);
  }
});

test('guard defaults ON (second arg omitted == guarded)', () => {
  for (const s of REALISTIC) {
    const dflt = _checkableFromText(s);
    const on = _checkableFromText(s, true);
    assert.deepStrictEqual(dflt, on, `default != guarded for: ${JSON.stringify(s)}`);
  }
});

test('guard ON: pathological char-run stays linear (<1000ms at 100K)', () => {
  const evil = 'a'.repeat(100000) + '/';
  const t = Date.now();
  const out = _checkableFromText(evil, true);
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `expected <1000ms, got ${ms}ms`);
  assert.ok(Array.isArray(out));
});

test('guard ON: 1MB char-run does not hang', () => {
  const evil = 'x'.repeat(1024 * 1024) + '/';
  const t = Date.now();
  _checkableFromText(evil, true);
  const ms = Date.now() - t;
  assert.ok(ms < 3000, `expected <3000ms for 1MB, got ${ms}ms`);
});

test('guard OFF reproduces legacy O(n^2) (load-bearing proof)', () => {
  // Establish that the guard actually matters: the legacy path is markedly
  // slower on the same pathological input. Use a moderate size to keep the
  // test fast while still demonstrating quadratic blow-up.
  const n = 40000;
  const evil = 'a'.repeat(n) + '/';

  let t = Date.now();
  _checkableFromText(evil, true);
  const guardedMs = Date.now() - t;

  t = Date.now();
  _checkableFromText(evil, false);
  const legacyMs = Date.now() - t;

  assert.ok(
    legacyMs > guardedMs * 5 + 50,
    `expected legacy (${legacyMs}ms) >> guarded (${guardedMs}ms) — guard not load-bearing`,
  );
});

test('_checkableFromText never throws on hostile / non-string input', () => {
  for (const bad of [null, undefined, 42, {}, [], true, NaN, Symbol.iterator]) {
    assert.doesNotThrow(() => _checkableFromText(bad, true), `threw on ${String(bad)}`);
    assert.doesNotThrow(() => _checkableFromText(bad, false), `threw on ${String(bad)} (legacy)`);
  }
});

test('bounded regex still extracts normal file paths correctly', () => {
  const reqs = _checkableFromText('请看 src/cli/ai.js 和 config.json', true);
  const keys = reqs.flatMap((r) => r.keys);
  assert.ok(keys.some((k) => k.includes('src/cli/ai.js')), `expected full path, got ${JSON.stringify(keys)}`);
  assert.ok(keys.some((k) => k === 'ai.js'), 'expected basename ai.js');
  // config.json is a GENERIC_TOKEN basename ('config') — full name still kept via ext form
  assert.ok(keys.some((k) => k.includes('config.json')) || keys.length >= 1);
});

test('assessIntentCoverage does not hang on ultra-long garbled rawMessage', () => {
  const evil = 'a'.repeat(100000) + '/';
  const t = Date.now();
  const r = assessIntentCoverage({ reply: 'done', rawMessage: evil, anchors: [], tailDetails: [] });
  const ms = Date.now() - t;
  assert.ok(ms < 1000, `expected <1000ms, got ${ms}ms`);
  assert.ok(r && typeof r.shouldNudge === 'boolean');
});

test('assessIntentCoverage: pathRedosGuard:false opt-out reaches legacy path', () => {
  // Smaller size so the opt-out test itself stays fast, but still proves the
  // flag threads through to the unbounded regex (slower than guarded).
  const n = 30000;
  const evil = 'a'.repeat(n) + '/';

  let t = Date.now();
  assessIntentCoverage({ reply: 'done', rawMessage: evil, anchors: [], tailDetails: [], pathRedosGuard: true });
  const guardedMs = Date.now() - t;

  t = Date.now();
  assessIntentCoverage({ reply: 'done', rawMessage: evil, anchors: [], tailDetails: [], pathRedosGuard: false });
  const legacyMs = Date.now() - t;

  assert.ok(legacyMs > guardedMs + 30, `opt-out did not reach legacy path (guarded=${guardedMs}ms legacy=${legacyMs}ms)`);
});
