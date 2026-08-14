'use strict';

/**
 * Round-6 regression: REPL vim count clamp (freeze guard).
 *
 * A typed numeric prefix in NORMAL mode (e.g. "999999999d999999999w") flows
 * into O(count) motion loops and O(count) paste/toggle string builders inside
 * src/vim/. Without a cap this froze the single-threaded event loop straight
 * from the keyboard (>30s). The sibling TUI vim already clamps to
 * MAX_VIM_COUNT=10000; this test locks the same clamp into the REPL copy and
 * proves the byte-identical legacy fallback when the gate is disabled.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const TRANS_PATH = path.join(__dirname, '..', 'src', 'vim', 'transitions.js');
const TYPES_PATH = path.join(__dirname, '..', 'src', 'vim', 'types.js');

function loadWithGate(value) {
  delete require.cache[require.resolve(TRANS_PATH)];
  // The gate reads process.env at call-time, so leave the value set through the
  // caller's assertions; each loadWithGate call overwrites it fresh.
  if (value === undefined) delete process.env.KHY_VIM_COUNT_CLAMP;
  else process.env.KHY_VIM_COUNT_CLAMP = value;
  return require(TRANS_PATH);
}

test.afterEach(() => {
  delete process.env.KHY_VIM_COUNT_CLAMP;
});

const { createVimState, Mode } = require(TYPES_PATH);

function drive(mod, keys, line) {
  const state = createVimState();
  state.mode = Mode.NORMAL;
  const ctx = { line, cursor: 0 };
  const start = Date.now();
  let r;
  for (const k of keys) r = mod.transition(state, k, ctx);
  return { ms: Date.now() - start, result: r };
}

function digits(n) {
  return String(n).split('');
}

test('huge operator+count multiply does not freeze (returns fast)', () => {
  const mod = loadWithGate(undefined);
  // 999999999 * 999999999 ~= 10^18 effective count => O(count) loop = hard freeze pre-fix
  const keys = ['d', ...digits(999999999), 'w', ...digits(999999999)];
  // build proper sequence: <count>d<count2>w
  const seq = [...digits(999999999), 'd', ...digits(999999999), 'w'];
  const { ms } = drive(mod, seq, 'a b c d e');
  assert.ok(ms < 2000, `expected fast completion, got ${ms}ms`);
});

test('huge standalone count on word motion does not freeze', () => {
  const mod = loadWithGate(undefined);
  const seq = ['d', ...digits(100000000), 'w'];
  const { ms } = drive(mod, seq, 'a b c d e f');
  assert.ok(ms < 2000, `expected fast completion, got ${ms}ms`);
});

test('normal small counts still behave correctly (d2w)', () => {
  const mod = loadWithGate(undefined);
  const { result } = drive(mod, ['d', '2', 'w'], 'aa bb cc dd');
  assert.strictEqual(result.result.line, 'cc dd');
});

test('single-count motion unaffected (dw)', () => {
  const mod = loadWithGate(undefined);
  const { result } = drive(mod, ['d', 'w'], 'aa bb cc');
  assert.strictEqual(result.result.line, 'bb cc');
});

test('_clampCount caps at MAX_VIM_COUNT when enabled', () => {
  const mod = loadWithGate(undefined);
  assert.strictEqual(mod._clampCount(5), 5);
  assert.strictEqual(mod._clampCount(mod.MAX_VIM_COUNT), mod.MAX_VIM_COUNT);
  assert.strictEqual(mod._clampCount(mod.MAX_VIM_COUNT + 1), mod.MAX_VIM_COUNT);
  assert.strictEqual(mod._clampCount(999999999), mod.MAX_VIM_COUNT);
});

test('_clampCount passes non-finite / non-number through', () => {
  const mod = loadWithGate(undefined);
  assert.strictEqual(mod._clampCount(0), 0);
  assert.strictEqual(mod._clampCount(NaN) !== mod._clampCount(NaN), true); // NaN passthrough (NaN!==NaN)
  assert.strictEqual(mod._clampCount(Infinity), Infinity);
});

test('gate disabled restores unbounded legacy passthrough (byte-identical)', () => {
  const mod = loadWithGate('0');
  assert.strictEqual(mod._vimCountClampEnabled(), false);
  assert.strictEqual(mod._clampCount(999999999), 999999999);
  assert.strictEqual(mod._clampCount(mod.MAX_VIM_COUNT + 1), mod.MAX_VIM_COUNT + 1);
});

test('gate enabled by default and via explicit truthy', () => {
  assert.strictEqual(loadWithGate(undefined)._vimCountClampEnabled(), true);
  assert.strictEqual(loadWithGate('1')._vimCountClampEnabled(), true);
  assert.strictEqual(loadWithGate('off')._vimCountClampEnabled(), false);
  assert.strictEqual(loadWithGate('FALSE')._vimCountClampEnabled(), false);
});

test('getEffectiveCount clamps the product', () => {
  const mod = loadWithGate(undefined);
  assert.strictEqual(mod.getEffectiveCount({ count: 3, operatorCount: 4 }), 12);
  assert.strictEqual(mod.getEffectiveCount({ count: 999999, operatorCount: 999999 }), mod.MAX_VIM_COUNT);
  assert.strictEqual(mod.getEffectiveCount({ count: 0, operatorCount: 0 }), 1); // both default to 1
});
