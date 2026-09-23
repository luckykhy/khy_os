'use strict';

// wrapCell — single wrap + row-counting source (DESIGN-ARCH-103 P0-4 / H6).
// `node --test` (jest is broken under rtk for this tree).

const test = require('node:test');
const assert = require('node:assert');
const {
  wrapCell,
  visualRows,
  visualRowsUnwrapped,
  fitBorder,
  visWidth,
} = require('../../../src/cli/tui/wrapCell');

// ── H6 property: billing === render (visualRows === wrapCell().length) ───────
test('visualRows(t,w) === wrapCell(t,w).length over 30 random-ish combos', () => {
  const samples = [
    'hello world',
    '你好世界hello',
    'a b c d e f g',
    '❤️🚀🚀',
    'x'.repeat(500),
    '中文，。！？标点禁则测试',
    '',
    'a\nb\nc',
    '短',
    'word'.repeat(200),
  ];
  for (let i = 0; i < 30; i++) {
    const t = samples[i % samples.length];
    const w = [0, 1, 3, 4, 8, 10, 40, 80, 200][i % 9];
    assert.equal(visualRows(t, w), wrapCell(t, w).length, `t=${JSON.stringify(t).slice(0, 20)} w=${w}`);
  }
});

// ── wrapping semantics ────────────────────────────────────────────────────────
test('wrapCell: short text fits → single segment', () => {
  assert.deepEqual(wrapCell('abc', 3), ['abc']);
  assert.deepEqual(wrapCell('abc', 4), ['abc']);
});

// BUG-115: broad CSI param family (`:` truecolor, `>`, ESC-intermediate) must stay
// atomic/zero-width. Old ESC_SEQ_RE class `[0-9;?]` split them → digits leaked.
test('wrapCell: colon-truecolor / private CSI / ESC-intermediate stay atomic', () => {
  const E = String.fromCharCode(27);
  const cases = [
    'a' + E + '[38:2:255:128:0mBCDEFGH' + E + '[0m',
    'AB' + E + '[>cCDEF',
    'AB' + E + '(B' + E + '[0mCDEF',
  ];
  for (const s of cases) {
    const segs = wrapCell(s, 8);
    assert.equal(segs.length, 1, 'escape stays atomic (zero-width) -> single row');
    assert.equal(segs.join(''), s, 'no characters dropped');
  }
});

test('wrapCell: hard wrap at display-width boundary (no word split of CJK)', () => {
  const segs = wrapCell('abracadabra', 4);
  assert.ok(segs.every((s) => visWidth(s) <= 4 || visWidth(s) > 4 === visWidth(s)), 'each segment <= cap unless single char wider');
  assert.equal(segs.join(''), 'abracadabra', 'no characters dropped');
});

test('wrapCell: CJK double-width counts correctly (你好 = 4 cols)', () => {
  assert.equal(visWidth('你好'), 4);
  const segs = wrapCell('你好世界abc', 10);
  // 你好世界 = 8 cols, +abc = 11 > 10 → wraps after the CJK run
  assert.equal(segs.join(''), '你好世界abc', 'no characters dropped');
  assert.ok(segs.every((s) => visWidth(s) <= 10 || visWidth(s) === visWidth(s) && s.length === 1 && visWidth(s) > 10),
    'segments respect the cap');
});

test('wrapCell: surrogate pairs are never split in half', () => {
  const segs = wrapCell('a❤️b', 4);
  // No orphaned high surrogate may appear: every segment must be a valid string
  // whose re-join equals the original.
  assert.equal(segs.join(''), 'a❤️b');
  for (const s of segs) {
    assert.ok(!/[lead-surrogate]$/u.test(s));
  }
});

test('wrapCell: width<=0 → logical lines, no wrapping', () => {
  assert.deepEqual(wrapCell('abcd', 0), ['abcd']);
  assert.deepEqual(wrapCell('a\nb', -5), ['a', 'b']);
});

test('visualRowsUnwrapped: logical lines for pre-truncated content', () => {
  assert.equal(visualRowsUnwrapped('a\nb\nc'), 3);
  assert.equal(visualRowsUnwrapped(''), 0);
  assert.equal(visualRowsUnwrapped('x'), 1);
});

// ── fitBorder (H4: top+bottom from one function → equal width) ───────────────
test('fitBorder: display width exactly equals the requested width', () => {
  for (const w of [40, 79, 80, 119, 120, 121, 200]) {
    const top = fitBorder(w, { left: '╭', right: '╮' });
    const bot = fitBorder(w, { left: '╰', right: '╯' });
    assert.equal(visWidth(top), w, `top @${w}`);
    assert.equal(visWidth(bot), w, `bottom @${w}`);
  }
});

test('fitBorder: degenerate width never goes negative', () => {
  assert.equal(visWidth(fitBorder(2, { left: '╭', right: '╮' })), 2);
  assert.equal(visWidth(fitBorder(1)), 1);
  assert.equal(visWidth(fitBorder(0)), 0);
});

test('fitBorder: busy gutter switches mid char but keeps width', () => {
  assert.equal(visWidth(fitBorder(20, { left: '╭', right: '╮', busy: true })), 20);
  assert.ok(fitBorder(20, { left: '╭', right: '╮', busy: true }).includes('╌'));
  assert.ok(!fitBorder(20, { left: '╭', right: '╮' }).includes('╌'));
});

// ── ANSI awareness (BUG-32: a wrap point must never fall inside a sequence) ──
const ANSI_CODE = '未跟踪的本地密钥文件不会出现在 \x1b[36mgit status\x1b[39m 里，这一句要足够长以便越过任何合理的列宽上限。';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
// A row whose trailing ESC has no terminating final byte = a sawn sequence.
function cutSequences(rows) {
  return rows.filter((s) => {
    const at = s.lastIndexOf('\x1b[');
    return at >= 0 && !/\x1b\[[0-9;?]*[ -/]*[@-~]/.test(s.slice(at));
  });
}

test('wrapCell: never cuts an ANSI sequence, at any width (BUG-32)', () => {
  for (let w = 1; w <= 40; w++) {
    const segs = wrapCell(ANSI_CODE, w);
    assert.deepEqual(cutSequences(segs), [], `width ${w} produced a sawn escape sequence`);
    // Re-joining must reproduce the input byte-for-byte apart from the SGR
    // close/reopen the splitter legitimately injects.
    assert.equal(stripAnsi(segs.join('')), stripAnsi(ANSI_CODE), `width ${w} dropped visible text`);
    for (const s of segs) {
      const visible = stripAnsi(s).length;
      assert.ok(
        visWidth(s) <= w || visible <= 1,
        `width ${w}: row over the cap with more than one glyph: ${JSON.stringify(s)}`
      );
    }
  }
});

test('wrapCell: escape bytes consume no display width', () => {
  // 'aaaa ' is 5 columns; the 9-column colored word then fits exactly in 14,
  // proving the 9 bytes of `\x1b[36m` cost nothing.
  assert.deepEqual(wrapCell('aaaa \x1b[36mbbbbbbbbb\x1b[39m', 14), ['aaaa \x1b[36mbbbbbbbbb\x1b[39m']);
  assert.deepEqual(wrapCell('aaaa \x1b[36mbbbbbbbbb\x1b[39m', 13), [
    'aaaa \x1b[36mbbbbbbbb\x1b[0m',
    '\x1b[36mb\x1b[39m',
  ]);
});

test('wrapCell: a style spanning the wrap point closes and reopens', () => {
  const segs = wrapCell('aaaa \x1b[36mbbbbbbbbb\x1b[39m', 10);
  assert.deepEqual(segs, [
    'aaaa \x1b[36mbbbbb\x1b[0m',
    '\x1b[36mbbbb\x1b[39m',
  ], 'the split row must not leak color past its end; the next one reopens it');
});

test('wrapCell: H6 billing holds for ANSI text too', () => {
  for (const w of [1, 7, 13, 20, 40]) {
    assert.equal(visualRows(ANSI_CODE, w), wrapCell(ANSI_CODE, w).length);
  }
});

// ── visWidth fallback safety ─────────────────────────────────────────────────
test('visWidth: emoji width 2, CJK 2, ASCII 1', () => {
  assert.equal(visWidth('a'), 1);
  assert.equal(visWidth('❤️'), 2);
  assert.equal(visWidth('你'), 2);
});
