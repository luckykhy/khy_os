'use strict';
/**
 * BUG-95 regression: the TUI vim twin (src/cli/tui/vim/) must step h/l and bound
 * x-deletions by grapheme, not by UTF-16 code unit.
 *
 * Round-8 fixed the base prompt Cursor (utils/Cursor.js → cursorGraphemeStep.test.js);
 * Round-9 fixed the REPL vim engine (src/vim/ → vimGraphemeOperators.test.js), whose
 * header *claimed* "the TUI vim twin already used firstGrapheme/lastGrapheme". That was
 * only partly true: the twin's word/text-object operators use measuredText, but
 * VimCursor.left()/right() still did raw offset±1 and executeX bounded its delete with
 * right(). In vim NORMAL, h/l (and the ←/→ arrows useVimInput maps onto them) could rest
 * between a surrogate pair, and `x` over an emoji left a lone surrogate → silent 乱码 in
 * the user's own prompt text, user-reachable from the live Ink TUI (App.js useVimInput).
 *
 * Grapheme stepping is byte-identical for all-BMP text, so unlike the gated REPL fix this
 * needs no KHY_*_GRAPHEME flag: the only behavior change is astral chars, which were
 * broken before. These tests lock that in.
 *
 * BUG-96 (follow-up, same file): `_wordEnd` (e/E) parks ON the last char of the word, so
 * for a trailing astral char its raw code-unit landing offset was the pair's LOW half — a
 * mid-pair caret that any downstream slice (d+e, backspace) tore into 乱码. `_wordEnd` now
 * snaps that offset back to the grapheme start via `_alignGrapheme`. The BUG-95 h/l/x cases
 * above stay green; the e/E cases below lock the new snap.
 */
const test = require('node:test');
const assert = require('node:assert');

const { VimCursor } = require('../src/cli/tui/vim/cursor');
const { executeX } = require('../src/cli/tui/vim/operators');

const EMOJI = '\u{1F600}';  // 😀, pair d83d de00
const ASTRAL = '\u{20000}'; // 𠀀, pair d840 dc00

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

test('right() steps over a whole astral char, never lands mid-pair', () => {
  const text = 'a' + EMOJI + 'b'; // code units: 61 d83d de00 62
  let c = VimCursor.fromText(text, 0);
  const seen = [];
  for (let i = 0; i < 3; i++) { c = c.right(); seen.push(c.offset); }
  assert.deepStrictEqual(seen, [1, 3, 4]); // skips 2 (the low half)
});

test('left() from after a pair lands before it', () => {
  const text = EMOJI + 'ok';
  const c = VimCursor.fromText(text, EMOJI.length); // offset 2
  assert.strictEqual(c.left().offset, 0);
});

test('executeX over an emoji deletes the whole pair (no lone surrogate)', () => {
  const text = 'a' + EMOJI + 'b';
  let out = null;
  const ctx = {
    cursor: new VimCursor(text, 1), // caret on the high half
    text,
    setText: (t) => { out = t; },
    setOffset: () => {},
    setRegister: () => {},
    recordChange: () => {},
  };
  executeX(1, ctx);
  assert.strictEqual(out, 'ab');
  assert.ok(!hasLoneSurrogate(out));
});

test('executeX with count over multiple astral chars deletes whole code points', () => {
  const text = EMOJI + ASTRAL + 'z';
  let out = null; let reg = null;
  const ctx = {
    cursor: new VimCursor(text, 0),
    text,
    setText: (t) => { out = t; },
    setOffset: () => {},
    setRegister: (c) => { reg = c; },
    recordChange: () => {},
  };
  executeX(2, ctx);
  assert.strictEqual(out, 'z');
  assert.ok(!hasLoneSurrogate(out));
  assert.ok(!hasLoneSurrogate(reg || ''));
});

test('BMP text (ASCII + CJK) walks identically: h/l reach both ends by length', () => {
  const text = 'hello 你好 世界'; // all BMP, 1 code unit each
  let r = VimCursor.fromText(text, 0);
  for (let i = 0; i < text.length; i++) r = r.right();
  assert.strictEqual(r.offset, text.length);
  let l = VimCursor.fromText(text, text.length);
  for (let i = 0; i < text.length; i++) l = l.left();
  assert.strictEqual(l.offset, 0);
});

// ── BUG-96: e/E (`_wordEnd`) parked the caret mid-pair ──────────────────────
// 'e'/'E' rest ON the last char of the word; for a trailing astral char the raw
// code-unit landing offset is the pair's LOW half. From there any downstream
// slice (d+e, backspace) tore the emoji → 乱码. _wordEnd now aligns back to the
// grapheme start. w/b (`_wordForward`/`_wordBackward`) already land on grapheme
// starts, so only the end motions needed the snap.

function isPairInterior(text, i) {
  return i > 0 && i < text.length
    && text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff
    && text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff;
}

test('endOfVimWord / endOfWORD never park on a surrogate pair interior', () => {
  const cases = [
    ['a' + EMOJI + 'b', 0],
    ['a' + EMOJI, 0],           // emoji at end: old landing was offset 2 (low half)
    [EMOJI + 'x', 0],
    ['hello ' + EMOJI, 0],
    ['x' + EMOJI + 'y' + EMOJI, 0],
    ['a' + ASTRAL + ' ' + EMOJI, 0],
  ];
  for (const [text, off] of cases) {
    const c = VimCursor.fromText(text, off);
    assert.ok(!isPairInterior(text, c.endOfVimWord().offset), `e mid-pair in ${JSON.stringify(text)}`);
    assert.ok(!isPairInterior(text, c.endOfWORD().offset), `E mid-pair in ${JSON.stringify(text)}`);
  }
});

test('e on "a😀" parks at the grapheme start (offset 1), not the low half (2)', () => {
  const text = 'a' + EMOJI;
  const c = VimCursor.fromText(text, 0);
  assert.strictEqual(c.endOfVimWord().offset, 1);
});

test('BMP e/E offsets unchanged by the grapheme snap (no regression)', () => {
  const text = 'foo bar baz'; // 'e' from 0 → 2 (end of "foo")
  const c = VimCursor.fromText(text, 0);
  assert.strictEqual(c.endOfVimWord().offset, 2);
  const cn = VimCursor.fromText('你好 世界', 0);
  assert.strictEqual(cn.endOfWORD().offset, 1); // 好 (space at 2 ends the WORD)
});

// `t`/`T` (findCharacter till) step one code unit off the found BMP char and can
// land on the low half of an adjacent astral pair — same mid-pair class as e/E.
test('forward-till find never parks on a pair interior', () => {
  const text = 'a' + EMOJI + 'b'; // a=0, emoji 1..2, b=3
  const c = VimCursor.fromText(text, 0);
  const tillB = c.findCharacter('b', 't', 1); // old landing: 2 (low half)
  assert.ok(!isPairInterior(text, tillB), 'dt<b> parked mid-pair');
  assert.strictEqual(tillB, 1); // grapheme start of the emoji
  const c2 = VimCursor.fromText(EMOJI + 'a', 0);
  assert.ok(!isPairInterior(EMOJI + 'a', c2.findCharacter('a', 't', 1)));
});

test('BMP till-find offsets unchanged by the snap', () => {
  const c = VimCursor.fromText('hello', 0);
  assert.strictEqual(c.findCharacter('o', 't', 1), 3); // just before 'o'
});

// ── BUG-96 (find half): f/F/t/T could not target an astral char ─────────────
// The old loop compared `text[i] === char` by UTF-16 code unit, so a 2-unit
// needle (emoji / CJK ext-B) never equaled any single unit and findCharacter
// returned null — `f😀` silently did nothing (no motion, no error), and `;`/`,`
// repeat (which stores the same astral char) failed the same way. findCharacter
// now matches at CODE-POINT granularity. (A single code point is the engine's
// documented matching unit — a multi-code-point ZWJ cluster is still out of
// scope, consistent with the code-point design used everywhere else here.)
test('f finds an astral char, landing on its pair start (not null)', () => {
  const text = 'x' + EMOJI + 'y'; // x=0, emoji 1..2, y=3
  assert.strictEqual(VimCursor.fromText(text, 0).findCharacter(EMOJI, 'f', 1), 1);
  assert.ok(!isPairInterior(text, 1));
});

test('F finds an astral char backward', () => {
  const text = 'x' + EMOJI + 'y';
  assert.strictEqual(VimCursor.fromText(text, 3).findCharacter(EMOJI, 'F', 1), 1);
});

test('t of an astral char parks one code point before it (no mid-pair)', () => {
  const text = 'ab' + EMOJI; // a=0 b=1 emoji 2..3
  const till = VimCursor.fromText(text, 0).findCharacter(EMOJI, 't', 1);
  assert.strictEqual(till, 1); // 'b', the grapheme before the emoji
  assert.ok(!isPairInterior(text, till));
});

test('T of an astral char parks one code point after it (no mid-pair)', () => {
  const text = EMOJI + 'ab'; // emoji 0..1 a=2 b=3
  const till = VimCursor.fromText(text, 3).findCharacter(EMOJI, 'T', 1);
  assert.strictEqual(till, 2); // 'a', just past the pair
  assert.ok(!isPairInterior(text, till));
});

test('2f over astral chars lands on the second occurrence by code point', () => {
  const text = 'x' + EMOJI + 'y' + EMOJI; // x=0, pair 1..2, y=3, pair 4..5
  // From 0, the emoji strictly after the cursor sit at offsets 1 and 4 → 2f → 4.
  assert.strictEqual(VimCursor.fromText(text, 0).findCharacter(EMOJI, 'f', 2), 4);
});

test('astral ext-B (CJK U+20000) is findable too', () => {
  const text = 'a' + ASTRAL + 'b';
  assert.strictEqual(VimCursor.fromText(text, 0).findCharacter(ASTRAL, 'f', 1), 1);
});

test('empty/null needle returns null (no spurious match)', () => {
  assert.strictEqual(VimCursor.fromText('abc', 0).findCharacter('', 'f', 1), null);
  assert.strictEqual(VimCursor.fromText('abc', 0).findCharacter(null, 'f', 1), null);
});

// ── BUG-96 (vertical half): j/k column math parked the caret mid-pair ────────
// _verticalMove computed `column` as a code-unit count (getPosition) and
// re-applied it to the target line, whose astral chars occupy 2 units each. A
// k from a pure-ASCII line onto "ab😀cd" at column 3 landed on the emoji's LOW
// half (offset 3) — a mid-pair caret that x/d/backspace then tore into 乱码.
// The landing now snaps back to the grapheme start via _alignGrapheme.
test('k onto a line with an astral char never parks mid-pair', () => {
  const text = 'ab' + EMOJI + 'cd\nwxyz'; // line0: a0 b1 [2..3]=emoji c4 d5; \n6; line1 w7..
  const up = VimCursor.fromText(text, text.indexOf('\n') + 1 + 3).upLogicalLine(); // col3
  assert.ok(!isPairInterior(text, up.offset), 'k landed on a surrogate low half');
  assert.strictEqual(up.offset, 2); // snapped to the emoji's start
});

test('j/k keep valid boundaries and pure-ASCII columns unchanged', () => {
  // col at a real boundary stays put.
  const text = 'ab' + EMOJI + 'cd\nwxyz';
  const up4 = VimCursor.fromText(text, text.indexOf('\n') + 1 + 4).upLogicalLine(); // col4 -> 'c'
  assert.strictEqual(up4.offset, 4);
  assert.ok(!isPairInterior(text, up4.offset));
  // all-BMP two-line text walks identically.
  const ascii = 'abcde\nfghij';
  assert.strictEqual(VimCursor.fromText(ascii, 8).upLogicalLine().offset, 2); // col2 -> 2
  assert.strictEqual(VimCursor.fromText(ascii, 2).downLogicalLine().offset, 8); // col2 -> line1
});

// ── BUG-97: leaving INSERT to NORMAL stepped the caret back one code unit ─────
// useVimInput.switchToNormalMode did setOffset(offset-1) when Esc-ing out of
// INSERT. After typing an astral char the caret sat just past its low half, so
// offset-1 landed ON the low half; a follow-up `x` then deleted a lone
// surrogate (乱码). The hook now steps back via VimCursor.left() (grapheme).
// We lock the operator-level consequence the hook relies on.
test('Esc-to-NORMAL caret (left()) then x deletes the whole trailing emoji', () => {
  const text = 'x' + EMOJI; // x=0, emoji 1..2, offset after insert = 3
  const escCaret = VimCursor.fromText(text, 3).left().offset;
  assert.strictEqual(escCaret, 1); // grapheme start, NOT the raw 2 (low half)
  let out = null;
  const ctx = {
    cursor: new VimCursor(text, escCaret),
    text,
    setText: (t) => { out = t; },
    setOffset: () => {},
    setRegister: () => {},
    recordChange: () => {},
  };
  executeX(1, ctx);
  assert.strictEqual(out, 'x');
  assert.ok(!hasLoneSurrogate(out));
});



