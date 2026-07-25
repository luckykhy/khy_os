'use strict';

/**
 * Round-8 regression: TUI prompt Cursor grapheme-aware stepping (乱码 guard).
 *
 * Cursor.left/right/backspace/del stepped ±1 UTF-16 code unit. Over an astral
 * character (emoji 😀, 𝕏, CJK ext-B 𠀀 — all surrogate pairs) a single
 * Backspace / arrow / Delete tore the pair, leaving a lone surrogate that
 * UTF-8-encodes to U+FFFD (efbfbd) — silent 乱码 in the user's OWN typed text
 * before it reaches the model. This is user-reachable from every raw keystroke
 * in the Ink TUI prompt (useTextInput backspace/left/right/del).
 *
 * Fix routes those four through code-point stepping (mirrors the sibling
 * VimCursor.measuredText). Gate KHY_CURSOR_GRAPHEME; off → legacy ±1 stepping,
 * byte-identical for all-BMP text.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CURSOR_PATH = path.join(__dirname, '..', 'src', 'cli', 'tui', 'utils', 'Cursor.js');

function load(gate) {
  delete require.cache[require.resolve(CURSOR_PATH)];
  if (gate === undefined) delete process.env.KHY_CURSOR_GRAPHEME;
  else process.env.KHY_CURSOR_GRAPHEME = gate;
  return require(CURSOR_PATH).Cursor;
}

test.afterEach(() => { delete process.env.KHY_CURSOR_GRAPHEME; });

const EMOJI = '😀';        // U+1F600, surrogate pair d83d de00
const ASTRAL = '𠀀';       // U+20000 CJK ext-B, surrogate pair d840 dc00

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

test('backspace over an emoji deletes the whole pair (no lone surrogate)', () => {
  const C = load(undefined);
  const c = new C('', 0).insert(EMOJI);
  const b = c.backspace();
  assert.strictEqual(b.text, '');
  assert.strictEqual(b.offset, 0);
  assert.ok(!hasLoneSurrogate(b.text));
});

test('backspace over astral char before text keeps rest intact', () => {
  const C = load(undefined);
  const c = new C(ASTRAL + 'ok', (ASTRAL + 'ok').length);
  // caret at end, backspace twice over 'k','o', then over astral char
  const b = c.backspace().backspace().backspace();
  assert.strictEqual(b.text, '');
  assert.ok(!hasLoneSurrogate(b.text));
});

test('del over an emoji deletes the whole pair forward', () => {
  const C = load(undefined);
  const c = new C(EMOJI + 'ok', 0);
  const d = c.del();
  assert.strictEqual(d.text, 'ok');
  assert.ok(!hasLoneSurrogate(d.text));
});

test('left() from after a pair lands before it (skips whole pair)', () => {
  const C = load(undefined);
  const c = new C(EMOJI + 'ok', EMOJI.length); // offset 2 = just after pair
  const l = c.left();
  assert.strictEqual(l.offset, 0);
});

test('right() from before a pair lands after it (skips whole pair)', () => {
  const C = load(undefined);
  const c = new C(EMOJI + 'ok', 0);
  const r = c.right();
  assert.strictEqual(r.offset, EMOJI.length); // 2
});

test('inserting mid-buffer after grapheme-left does not tear a pair', () => {
  const C = load(undefined);
  const c = new C(EMOJI + 'ok', EMOJI.length);
  const torn = c.left().insert('a'); // grapheme-left → offset 0, insert 'a'
  assert.ok(!hasLoneSurrogate(torn.text));
  assert.strictEqual(torn.text, 'a' + EMOJI + 'ok');
});

test('BMP text is byte-identical with gate on vs off', () => {
  const on = load(undefined);
  const off = load('0');
  for (const op of ['backspace', 'del', 'left', 'right']) {
    const a = new on('hello world', 5)[op]();
    const b = new off('hello world', 5)[op]();
    assert.strictEqual(a.text, b.text, `${op} text`);
    assert.strictEqual(a.offset, b.offset, `${op} offset`);
  }
});

test('gate disabled reproduces the legacy surrogate-tearing (load-bearing)', () => {
  const C = load('0');
  const c = new C('', 0).insert(EMOJI);
  const b = c.backspace();
  // legacy path: only one code unit removed → lone high surrogate remains
  assert.strictEqual(b.text.length, 1);
  assert.ok(hasLoneSurrogate(b.text), 'legacy path should leave a lone surrogate (proves guard is load-bearing)');
  // and it encodes to U+FFFD (乱码) under UTF-8
  assert.strictEqual(Buffer.from(b.text).toString('hex'), 'efbfbd');
});

test('multiple mixed BMP + astral edits never produce a lone surrogate', () => {
  const C = load(undefined);
  let c = new C('', 0);
  c = c.insert('a').insert(EMOJI).insert('b').insert(ASTRAL).insert('c');
  // walk backspacing everything
  while (c.offset > 0) {
    c = c.backspace();
    assert.ok(!hasLoneSurrogate(c.text), `lone surrogate after backspace at offset ${c.offset}`);
  }
  assert.strictEqual(c.text, '');
});
