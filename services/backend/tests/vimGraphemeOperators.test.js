'use strict';

/**
 * Round-9 regression: REPL vim operators grapheme-aware editing (乱码 guard).
 *
 * The REPL vim engine (src/vim/, distinct from the TUI cli/tui/vim/ twin) sliced
 * edits by UTF-16 code unit in x / X / r / ~ / s and the d/c/y operator ranges.
 * Because h/l motions step the cursor ±1 code unit (motions.js resolveMotion
 * 'h'/'l'), the caret can rest between the two halves of an astral character
 * (emoji 😀, CJK ext-B 𠀀). A single x / r there tore the surrogate pair into a
 * lone surrogate → UTF-8 U+FFFD (efbfbd) → silent 乱码 in the user's own text.
 *
 * The TUI vim twin already used firstGrapheme/lastGrapheme; only the REPL engine
 * was missed (same single-point-fix gap as Round-6/Round-8). Fix snaps edit
 * boundaries to whole code points. Gate KHY_VIM_GRAPHEME; off → legacy ±1
 * slicing, byte-identical for all-BMP text.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const OPS_PATH = path.join(__dirname, '..', 'src', 'vim', 'operators.js');

function load(gate) {
  delete require.cache[require.resolve(OPS_PATH)];
  if (gate === undefined) delete process.env.KHY_VIM_GRAPHEME;
  else process.env.KHY_VIM_GRAPHEME = gate;
  return require(OPS_PATH);
}

test.afterEach(() => { delete process.env.KHY_VIM_GRAPHEME; });

const EMOJI = '\u{1F600}';   // 😀, pair d83d de00
const ASTRAL = '\u{20000}';  // 𠀀, pair d840 dc00
const LINE = 'a' + EMOJI + 'b'; // units: 61 d83d de00 62, offsets a=0 pair=1..2 b=3

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

test('x on the high half of a pair deletes the whole emoji', () => {
  const m = load(undefined);
  const r = m.executeStandalone('x', LINE, 1, 1, { register: '' });
  assert.strictEqual(r.line, 'ab');
  assert.ok(!hasLoneSurrogate(r.line));
});

test('x on the low half of a pair snaps back and deletes the whole emoji', () => {
  const m = load(undefined);
  const r = m.executeStandalone('x', LINE, 2, 1, { register: '' });
  assert.strictEqual(r.line, 'ab');
  assert.ok(!hasLoneSurrogate(r.line));
});

test('X deleting back over an emoji removes the whole pair', () => {
  const m = load(undefined);
  // caret after the emoji (offset 3), X deletes the char before → whole emoji
  const r = m.executeStandalone('X', LINE, 3, 1, { register: '' });
  assert.strictEqual(r.line, 'ab');
  assert.ok(!hasLoneSurrogate(r.line));
});

test('r replaces the whole emoji, not one code unit', () => {
  const m = load(undefined);
  const r = m.executeStandalone('r', LINE, 1, 1, { register: '' }, 'Z');
  assert.strictEqual(r.line, 'aZb');
  assert.ok(!hasLoneSurrogate(r.line));
});

test('s substitutes the whole emoji with no lone surrogate', () => {
  const m = load(undefined);
  const r = m.executeStandalone('s', LINE, 1, 1, { register: '' });
  assert.strictEqual(r.line, 'ab');
  assert.ok(!hasLoneSurrogate(r.line));
});

test('~ toggling over an emoji leaves the pair intact (emoji has no case)', () => {
  const m = load(undefined);
  const r = m.executeStandalone('~', EMOJI, 0, 1, { register: '' });
  assert.strictEqual(r.line, EMOJI);
  assert.ok(!hasLoneSurrogate(r.line));
});

test('d operator with inclusive range on a pair deletes the whole emoji', () => {
  const m = load(undefined);
  const r = m.executeOperator('d', { start: 1, end: 1, inclusive: true }, LINE, 1, { register: '' });
  assert.strictEqual(r.line, 'ab');
  assert.ok(!hasLoneSurrogate(r.line));
});

test('x over multiple astral chars (count) deletes whole code points', () => {
  const m = load(undefined);
  const line = EMOJI + ASTRAL + 'z'; // two pairs then z, len 5
  const r = m.executeStandalone('x', line, 0, 2, { register: '' });
  assert.strictEqual(r.line, 'z');
  assert.ok(!hasLoneSurrogate(r.line));
  assert.ok(!hasLoneSurrogate(r.register || ''));
});

test('BMP text is byte-identical with gate on vs off', () => {
  const on = load(undefined);
  const off = load('0');
  const bmp = 'hello world';
  const cases = [
    ['x', [bmp, 2, 1, { register: '' }]],
    ['X', [bmp, 3, 1, { register: '' }]],
    ['r', [bmp, 2, 1, { register: '' }, 'Z']],
    ['~', [bmp, 1, 3, { register: '' }]],
    ['s', [bmp, 4, 2, { register: '' }]],
  ];
  for (const [cmd, args] of cases) {
    const a = on.executeStandalone(cmd, ...args);
    const b = off.executeStandalone(cmd, ...args);
    assert.strictEqual(a.line, b.line, `${cmd} line`);
    assert.strictEqual(a.cursor, b.cursor, `${cmd} cursor`);
  }
  // operator ranges too
  const a = on.executeOperator('d', { start: 0, end: 3, inclusive: true }, bmp, 0, { register: '' });
  const b = off.executeOperator('d', { start: 0, end: 3, inclusive: true }, bmp, 0, { register: '' });
  assert.strictEqual(a.line, b.line, 'd line');
});

test('gate disabled reproduces the legacy surrogate-tearing (load-bearing)', () => {
  const m = load('0');
  const r = m.executeStandalone('x', LINE, 1, 1, { register: '' });
  assert.ok(hasLoneSurrogate(r.line), 'legacy x should tear the pair (proves guard is load-bearing)');
  assert.strictEqual(Buffer.from(r.line).toString('hex'), '61efbfbd62');
});
