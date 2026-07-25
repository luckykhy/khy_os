'use strict';

/**
 * promptFrameWrap.test.js — anti-spill input-render invariants (node:test).
 *
 * Goal "偶发性输入渲染错位（输入内容跑到输入框下方）": an over-width input line was
 * handed to Ink as ONE logical line, but the terminal hard-wrapped it into 2+
 * visual rows. Ink's eraser counts logical lines, so it under-erased and the
 * wrapped overflow of the input bled into the output region below the box.
 *
 * The fix pre-wraps each input line (CJK-aware) so logical rows == visual rows
 * and no row reaches the terminal margin. These cases are the PRESERVED
 * reproduction set required by the goal's hard constraint:
 *   - long ASCII line (the classic trigger)
 *   - long CJK line (wide chars, width-aware wrap)
 *   - mixed CJK+ASCII
 *   - a line whose width lands exactly on the margin (off-by-one hazard)
 *   - post-stream immediate long input (just a long value; the stream state is
 *     irrelevant once the row model is width-bounded)
 *   - multi-line (\n) input with the caret on a wrapped continuation row
 * and the invariants that prove the spill cannot recur:
 *   (A) every rendered row fits within cols-1 (never hits the pending-wrap cell)
 *   (B) rendered rows == sum of wrapped segments (logical == visual rows)
 *   (C) lossless: rebuilding the value from rows === original (no input loss)
 *   (D) exactly one row holds the caret, and it round-trips to the right offset
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const PromptFrame = require('../../src/cli/tui/ink-components/PromptFrame');
const { layoutPromptRows, wrapByWidth } = PromptFrame;
const { displayWidth } = require('../../src/cli/formatters');

const MARKER_W = 2;

// Rendered display width of a row: marker + text + (trailing caret cell when the
// caret sits at end-of-text, where a blank cursor block is appended).
function rowRenderWidth(row) {
  const caretPad = row.caretCol != null && row.caretCol >= row.text.length ? 1 : 0;
  return MARKER_W + displayWidth(row.text) + caretPad;
}

// Reconstruct the value from the row model: join wrapped segments within each
// logical line, then join logical lines with "\n".
function rebuildValue(rows) {
  const byLine = new Map();
  for (const r of rows) {
    if (r.isPlaceholder) continue;
    if (!byLine.has(r.lineIndex)) byLine.set(r.lineIndex, []);
    byLine.get(r.lineIndex).push(r.text);
  }
  const maxLine = Math.max(0, ...rows.map((r) => r.lineIndex));
  const out = [];
  for (let i = 0; i <= maxLine; i++) out.push((byLine.get(i) || ['']).join(''));
  return out.join('\n');
}

// The caret's global UTF-16 offset, recomputed from the row it lands on.
function caretOffsetFromRows(rows, value) {
  const lines = value.split('\n');
  const caretRow = rows.find((r) => r.caretCol != null);
  if (!caretRow) return null;
  // Sum lengths of earlier logical lines (+1 per "\n").
  let base = 0;
  for (let i = 0; i < caretRow.lineIndex; i++) base += lines[i].length + 1;
  // Sum lengths of earlier wrapped segments on the same logical line.
  let segBefore = 0;
  for (const r of rows) {
    if (r.lineIndex !== caretRow.lineIndex) continue;
    if (r === caretRow) break;
    segBefore += r.text.length;
  }
  return base + segBefore + caretRow.caretCol;
}

function assertInvariants(value, offset, cols) {
  const { rows, lineRowCount } = layoutPromptRows({ value, offset, cols });

  // (A) every row fits within cols-1 (never reaches the pending-wrap margin).
  for (const r of rows) {
    assert.ok(rowRenderWidth(r) <= cols - 1,
      `row width ${rowRenderWidth(r)} exceeds cols-1=${cols - 1} for ${JSON.stringify(r.text)}`);
  }

  // (B) rendered rows == sum of wrapped segments (logical == visual rows).
  const avail = Math.max(1, cols - MARKER_W - 2);
  const expectedSegs = value.split('\n').reduce((n, line) => n + wrapByWidth(line, avail).length, 0);
  assert.equal(lineRowCount, expectedSegs, 'row count must equal total wrapped segments');

  // (C) lossless reconstruction — no input is dropped by wrapping.
  assert.equal(rebuildValue(rows), value, 'value must round-trip through the row model');

  // (D) exactly one caret row, round-tripping to the requested offset (clamped).
  const caretRows = rows.filter((r) => r.caretCol != null);
  assert.equal(caretRows.length, 1, 'exactly one row carries the caret');
  const clamped = Math.min(Math.max(0, offset), value.length);
  assert.equal(caretOffsetFromRows(rows, value), clamped, 'caret offset must be preserved');
}

describe('PromptFrame layoutPromptRows — anti-spill invariants', () => {
  test('long ASCII line wraps; every row fits and caret is preserved', () => {
    const value = 'x'.repeat(500);
    for (const cols of [40, 80, 120]) {
      assertInvariants(value, value.length, cols); // caret at end
      assertInvariants(value, 250, cols);          // caret mid-line
    }
  });

  test('long CJK line wraps width-aware (wide chars never overflow)', () => {
    const value = '中文输入测试'.repeat(60); // 360 wide chars = 720 columns
    for (const cols of [40, 80, 100]) {
      assertInvariants(value, value.length, cols);
      assertInvariants(value, 100, cols);
    }
  });

  test('mixed CJK + ASCII line', () => {
    const value = ('用户输入hello world混合internationalization文本'.repeat(20));
    for (const cols of [50, 80]) assertInvariants(value, Math.floor(value.length / 2), cols);
  });

  test('width landing exactly on the margin (off-by-one hazard)', () => {
    // Construct values whose marker+text hits cols, cols-1, cols+1 around the edge.
    const cols = 80;
    for (const len of [cols - 3, cols - 2, cols - 1, cols, cols + 1, 2 * cols, 2 * cols + 1]) {
      assertInvariants('a'.repeat(len), len, cols);
    }
  });

  test('post-stream immediate long input (row model is width-bounded regardless)', () => {
    const value = '修复完成后我立刻输入了一段很长的中文回复用来验证流式输出之后输入框不会再错位'.repeat(8);
    assertInvariants(value, value.length, 80);
  });

  test('multi-line (\\n) input with caret on a wrapped continuation row', () => {
    const value = 'first line\n' + 'y'.repeat(300) + '\nthird';
    // caret inside the long middle line, past the first wrap boundary
    const offset = 'first line\n'.length + 200;
    assertInvariants(value, offset, 80);
  });

  test('empty value → single placeholder row, no caret, no border math blowup', () => {
    const { rows } = layoutPromptRows({ value: '', offset: 0, cols: 80, placeholder: 'type here' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].isPlaceholder, true);
    assert.equal(rows[0].isFirstOfValue, true);
    assert.equal(rows[0].caretCol, null);
  });

  test('only the very first row is marked isFirstOfValue (❯ marker)', () => {
    const value = 'z'.repeat(400) + '\nsecond';
    const { rows } = layoutPromptRows({ value, offset: 0, cols: 80 });
    assert.equal(rows.filter((r) => r.isFirstOfValue).length, 1);
    assert.equal(rows[0].isFirstOfValue, true);
  });

  test('narrow / degenerate terminal widths do not loop or crash', () => {
    for (const cols of [1, 2, 3, 5, 10]) {
      assert.doesNotThrow(() => layoutPromptRows({ value: '一二三456', offset: 3, cols }));
    }
  });
});

describe('layoutPromptRows — height cap (long-paste corollary)', () => {
  // The width fix wraps a huge paste into many rows; without a height cap the
  // box itself overflows the viewport and displaces (the same Ink under-erase,
  // now on the box). maxRows windows the rows around the caret. These cases are
  // PRESERVED regression guards for that corollary.
  const cols = 80;

  function countLineRows(rows) {
    return rows.filter((r) => r.kind !== 'ellipsis').length;
  }
  function caretRow(rows) {
    return rows.find((r) => r.kind !== 'ellipsis' && r.caretCol != null);
  }

  test('a huge paste is windowed to <= maxRows total and never overflows the box', () => {
    const value = 'x'.repeat(8000); // ~100+ wrapped rows at cols 80
    for (const maxRows of [4, 8, 14, 30]) {
      for (const offset of [0, 2000, value.length]) {
        const { rows } = layoutPromptRows({ value, offset, cols, maxRows });
        assert.ok(rows.length <= maxRows,
          `total rows ${rows.length} must be <= maxRows ${maxRows} (offset ${offset})`);
        // The box stays width-safe too (every line row still fits cols-1).
        for (const r of rows) {
          if (r.kind === 'ellipsis') continue;
          assert.ok(rowRenderWidth(r) <= cols - 1, 'windowed line row must still fit width');
        }
      }
    }
  });

  test('the caret row is always inside the window (caret never scrolls off)', () => {
    const value = '中文'.repeat(2000); // many wide-char rows
    const maxRows = 8;
    for (const offset of [0, 50, 1500, 3000, value.length]) {
      const { rows } = layoutPromptRows({ value, offset, cols, maxRows });
      const cr = caretRow(rows);
      assert.ok(cr, `a caret row must be present in the window (offset ${offset})`);
      assert.equal(rows.filter((r) => r.caretCol != null).length, 1, 'exactly one caret row');
    }
  });

  test('hidden head/tail are marked with ellipsis rows carrying the hidden count', () => {
    const value = 'y'.repeat(6000);
    const maxRows = 10;
    // caret in the middle → both sides hidden.
    const { rows, truncatedAbove, truncatedBelow, lineRowCount } = layoutPromptRows({
      value, offset: Math.floor(value.length / 2), cols, maxRows,
    });
    assert.ok(truncatedAbove && truncatedBelow, 'both sides should be truncated for a mid caret');
    const ell = rows.filter((r) => r.kind === 'ellipsis');
    assert.equal(ell.length, 2, 'one ellipsis row per hidden side');
    for (const e of ell) assert.ok(e.hidden > 0, 'ellipsis must report a positive hidden count');
    // lineRowCount still reports the FULL wrapped height (no data loss signalled).
    assert.ok(lineRowCount > maxRows, 'lineRowCount reflects the full input, not the window');
    // Hidden + shown line rows account for every wrapped row.
    const shown = countLineRows(rows);
    const hidden = ell.reduce((n, e) => n + e.hidden, 0);
    assert.equal(shown + hidden, lineRowCount, 'shown + hidden line rows == full height');
  });

  test('caret at the very end hides only the head (tail visible, no below marker)', () => {
    const value = 'z'.repeat(6000);
    const { rows, truncatedAbove, truncatedBelow } = layoutPromptRows({
      value, offset: value.length, cols, maxRows: 10,
    });
    assert.equal(truncatedBelow, false, 'end caret keeps the tail visible');
    assert.equal(truncatedAbove, true, 'head is hidden when caret is at the end');
    assert.equal(rows[rows.length - 1].caretCol != null, true, 'caret sits on the last shown row');
  });

  test('input within maxRows is shown in full (no windowing, no ellipsis)', () => {
    const value = 'short\nfew lines\nstill small';
    const { rows, truncatedAbove, truncatedBelow } = layoutPromptRows({
      value, offset: value.length, cols, maxRows: 20,
    });
    assert.equal(truncatedAbove, false);
    assert.equal(truncatedBelow, false);
    assert.equal(rows.some((r) => r.kind === 'ellipsis'), false, 'no ellipsis when it fits');
    assert.equal(rebuildValue(rows), value, 'fully shown input round-trips losslessly');
  });

  test('windowRows guarantees caret inclusion across all positions/budgets', () => {
    // Synthetic line rows: index i carries the caret iff i === caretIdx.
    for (const total of [5, 20, 137]) {
      for (const budget of [1, 2, 4, 9]) {
        for (const caretIdx of [0, 1, Math.floor(total / 2), total - 2, total - 1]) {
          const lineRows = Array.from({ length: total }, (_, i) => ({
            kind: 'line', lineIndex: i, text: String(i), caretCol: i === caretIdx ? 0 : null,
          }));
          const { rows } = PromptFrame.windowRows(lineRows, budget);
          assert.ok(rows.length <= budget, `total=${total} budget=${budget}: ${rows.length} <= ${budget}`);
          const cr = rows.find((r) => r.kind !== 'ellipsis' && r.caretCol != null);
          assert.ok(cr, `caret must be visible (total=${total} budget=${budget} caret=${caretIdx})`);
        }
      }
    }
  });
});

describe('wrapByWidth — segment correctness', () => {
  test('segments join back to the original line (lossless)', () => {
    for (const line of ['', 'short', 'a'.repeat(100), '中文'.repeat(50), 'mix混合abc']) {
      const segs = wrapByWidth(line, 12);
      assert.equal(segs.map((s) => s.text).join(''), line);
    }
  });

  test('no segment exceeds the cap (except an unavoidable single wide char)', () => {
    const segs = wrapByWidth('字'.repeat(40), 10);
    for (const s of segs) assert.ok(displayWidth(s.text) <= 10, `seg "${s.text}" wider than cap`);
  });

  test('empty line yields one empty segment (renderable, caret-holdable)', () => {
    assert.deepEqual(wrapByWidth('', 10), [{ text: '', start: 0, end: 0 }]);
  });

  test('start/end offsets are contiguous UTF-16 indices', () => {
    const segs = wrapByWidth('abcdefghij', 4);
    let cursor = 0;
    for (const s of segs) {
      assert.equal(s.start, cursor);
      cursor = s.end;
    }
    assert.equal(cursor, 10);
  });
});
