'use strict';

/**
 * Round-10 regression: TUI vim paste blow-up guard (crash/freeze).
 *
 * The vim count prefix is capped at MAX_VIM_COUNT (10000), but the paste
 * register is raw pasted human text — unbounded. executePaste multiplies them:
 *   - charwise: `content.repeat(count)` — a ~54-60 KB paste yanked then 10000p
 *     builds a >536 M-char string → RangeError: Invalid string length. The
 *     dispatch (useVimInput result.execute()) has no try/catch, so that
 *     RangeError tears down the Ink render loop = TUI crash.
 *   - linewise: `count × contentLines` push loop → 5·10⁷ pushes, multi-second
 *     freeze then OOM on join.
 * Both count and register are pure keyboard/paste input (reachable in vim mode).
 *
 * Fix bounds the effective repeat count so the product stays under
 * MAX_PASTE_OUTPUT. Gate KHY_VIM_PASTE_CAP; off → legacy unbounded multiply,
 * byte-identical for every realistic paste.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const OPS_PATH = path.join(__dirname, '..', 'src', 'cli', 'tui', 'vim', 'operators.js');
const CURSOR_PATH = path.join(__dirname, '..', 'src', 'cli', 'tui', 'vim', 'cursor.js');

function load(gate) {
  delete require.cache[require.resolve(OPS_PATH)];
  if (gate === undefined) delete process.env.KHY_VIM_PASTE_CAP;
  else process.env.KHY_VIM_PASTE_CAP = gate;
  return require(OPS_PATH);
}

test.afterEach(() => { delete process.env.KHY_VIM_PASTE_CAP; });

const { VimCursor } = require(CURSOR_PATH);

function makeCtx(text, offset, register) {
  const o = {
    getRegister: () => register,
    setRegister: () => {},
    recordChange: () => {},
  };
  let _off = offset;
  o.text = text;
  o.cursor = new VimCursor(text, offset);
  o.setText = (t) => { o.text = t; };
  o.setOffset = (x) => { _off = x; };
  return o;
}

test('_clampPasteCount leaves normal counts untouched', () => {
  const m = load(undefined);
  assert.strictEqual(m._clampPasteCount(5, 100), 5);
  assert.strictEqual(m._clampPasteCount(1, 999999999), 1);
  assert.strictEqual(m._clampPasteCount(0, 100), 0);
});

test('_clampPasteCount bounds the product at MAX_PASTE_OUTPUT', () => {
  const m = load(undefined);
  const unit = 60000;
  assert.strictEqual(m._clampPasteCount(10000, unit), Math.floor(m.MAX_PASTE_OUTPUT / unit));
  // exactly at the cap is preserved
  assert.strictEqual(m._clampPasteCount(10, 1000000), 10);
  // one over the cap gets reduced
  assert.ok(m._clampPasteCount(11, 1000000) < 11);
  // never below 1 even for a giant unit
  assert.strictEqual(m._clampPasteCount(10000, 999999999), 1);
});

test('_clampPasteCount passes through when unit is 0 (empty register)', () => {
  const m = load(undefined);
  assert.strictEqual(m._clampPasteCount(10000, 0), 10000);
});

test('charwise paste of a big register x huge count does not throw (was RangeError)', () => {
  const m = load(undefined);
  const reg = 'x'.repeat(60000); // one screenful of pasted text
  const ctx = makeCtx('abc', 0, reg);
  assert.doesNotThrow(() => m.executePaste(true, 10000, ctx));
  assert.ok(ctx.text.length <= m.MAX_PASTE_OUTPUT + 10);
});

test('linewise paste of many lines x huge count does not freeze/OOM', () => {
  const m = load(undefined);
  const reg = ('L\n').repeat(5000); // linewise register, 5000 content lines
  const ctx = makeCtx('start', 0, reg);
  const t0 = process.hrtime.bigint();
  assert.doesNotThrow(() => m.executePaste(true, 10000, ctx));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 4000, `linewise paste should stay bounded, took ${ms}ms`);
});

test('normal charwise paste is byte-identical with gate on vs off', () => {
  const on = load(undefined);
  const off = load('0');
  const reg = 'hi';
  const a = makeCtx('abc', 1, reg); on.executePaste(true, 3, a);
  const b = makeCtx('abc', 1, reg); off.executePaste(true, 3, b);
  assert.strictEqual(a.text, b.text);
  assert.strictEqual(a.text, 'abhihihic');
});

test('normal linewise paste is byte-identical with gate on vs off', () => {
  const on = load(undefined);
  const off = load('0');
  const reg = 'x\ny\n';
  const a = makeCtx('a\nb', 0, reg); on.executePaste(true, 2, a);
  const b = makeCtx('a\nb', 0, reg); off.executePaste(true, 2, b);
  assert.strictEqual(a.text, b.text);
  assert.strictEqual(a.text, 'a\nx\ny\nx\ny\nb');
});

test('gate disabled reproduces the legacy RangeError (load-bearing)', () => {
  const m = load('0');
  const reg = 'x'.repeat(60000);
  const ctx = makeCtx('abc', 0, reg);
  assert.throws(() => m.executePaste(true, 10000, ctx), /Invalid string length/);
});
