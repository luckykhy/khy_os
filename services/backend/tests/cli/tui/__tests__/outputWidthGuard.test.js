'use strict';
// QUARANTINE NOTE (historical): the original tests here were lost to encoding
// corruption (UTF-8 CJK mojibake destroyed the literals), leaving an empty
// shell recorded as debt in tests/DEBT.md. Restored below with real coverage —
// written with String.fromCharCode for control bytes so this file cannot be
// re-corrupted the same way — starting from the BUG-116 CJK-fold regression.
//
// node:test style (jest.config's node:test marker detection routes it out of
// jest, so both `node --test` and the wrapper see the same assertions).

const assert = require('node:assert');
const path = require('node:path');
const { describe, it } = require('node:test');

const SRC = path.join(__dirname, '../../../../src');
const { clampChunkToWidth, wrapAnsiLine } = require(path.join(SRC, 'cli/tui/runtime/outputWidthGuard'));
const { displayWidth } = require(path.join(SRC, 'cli/formatters'));

const E = String.fromCharCode(27); // ESC

const allFit = (out, cols) => out.split('\n').every((l) => displayWidth(l) <= cols);

describe('outputWidthGuard — CJK fold (BUG-116 regression)', () => {
  it('folds a CJK line whose length fits but display width overflows', () => {
    // 54 CJK chars: UTF-16 length 54 <= 80, but displayWidth 108 > 80. The
    // pre-fix fast paths short-circuited on `length <= cols` and returned this
    // unfolded, letting the terminal hard-wrap it and scramble layout.
    const cjk = '更新检查完成'.repeat(9);
    assert.ok(cjk.length <= 80, 'precondition: length fits in cols');
    assert.ok(displayWidth(cjk) > 80, 'precondition: display width overflows');
    const out = clampChunkToWidth(cjk, 80, displayWidth);
    assert.ok(out.split('\n').length >= 2, 'must fold, not defer to terminal wrap');
    assert.ok(allFit(out, 80), 'every folded line <= cols');
    assert.strictEqual(out.replace(/\n/g, ''), cjk, 'no characters dropped');
  });

  it('folds styled CJK and replays the active SGR on the continuation line', () => {
    const styled = E + '[31m' + '红字测试内容'.repeat(8) + E + '[0m';
    const rows = wrapAnsiLine(styled, 80, displayWidth);
    assert.ok(rows.length >= 2, 'styled CJK folds');
    assert.ok(rows.every((l) => displayWidth(l) <= 80), 'each row <= cols');
    assert.ok(rows[1].includes(E + '[31m'), 'color carried onto continuation');
    assert.ok(rows.join('').replace(new RegExp(E + '\\[[0-9;]*m', 'g'), '').includes('红字'), 'readable text kept');
  });
});

describe('outputWidthGuard — fast paths stay sound, not lax', () => {
  it('returns a short ASCII line byte-identical (zero-copy fast path)', () => {
    const ascii = 'khy update ok';
    assert.strictEqual(clampChunkToWidth(ascii, 80, displayWidth), ascii);
  });

  it('does NOT skip an ASCII line in (cols/2, cols] that still fits (measures instead)', () => {
    const a = 'a'.repeat(70); // length 70 <= 80, width 70 <= 80 -> unchanged via widthOf
    assert.strictEqual(clampChunkToWidth(a, 80, displayWidth), a);
    const b = 'a'.repeat(90); // width 90 > 80 -> must fold
    const out = clampChunkToWidth(b, 80, displayWidth);
    assert.ok(out.split('\n').length >= 2 && allFit(out, 80));
  });

  it('passes through writes containing non-SGR addressing sequences untouched', () => {
    const cup = '位置' + E + '[10;5H' + '尾';
    assert.strictEqual(clampChunkToWidth(cup, 80, displayWidth), cup, 'instant UI/寻址 must not be folded');
  });

  it('leaves cols<2 and empty input unchanged (never crashes)', () => {
    assert.strictEqual(clampChunkToWidth('x', 1, displayWidth), 'x');
    assert.strictEqual(clampChunkToWidth('', 80, displayWidth), '');
  });
});
