'use strict';

/**
 * Tests for toolDisplayPolicy.collapseConsecutiveDuplicates — the SINGLE source
 * of truth shared by the ink TUI (ToolLines) and the classic REPL (toolDisplay)
 * for folding a flood of identical lines.
 *
 * Motivation: `dir /s /a "C:\$Recycle.Bin" | findstr "File(s)"` emits hundreds of
 * identical "0 File(s) 0 bytes" lines that bury the one line that differs. The
 * user asked: show only the FIRST of a repeated run, with full output still
 * reachable via Ctrl+O. This pins that contract. Pure function — no ink, no async.
 */
const { collapseConsecutiveDuplicates } = require('../../src/cli/toolDisplayPolicy');

describe('collapseConsecutiveDuplicates', () => {
  test('collapses a long run to first occurrence + "+N 行相同" marker', () => {
    const lines = [
      ...Array.from({ length: 23 }, () => '0 File(s) 0 bytes'),
      '8686 File(s) 993,476,464 bytes',
    ];
    const out = collapseConsecutiveDuplicates(lines);
    expect(out.collapsed).toBe(true);
    // 23 identical → 1 shown + 22 hidden.
    expect(out.hiddenCount).toBe(22);
    expect(out.lines).toEqual([
      '0 File(s) 0 bytes',
      '… +22 行相同（ctrl+o 展开）',
      '8686 File(s) 993,476,464 bytes',
    ]);
  });

  test('the marker advertises ctrl+o so the expand promise is honest', () => {
    const lines = Array.from({ length: 5 }, () => 'dup');
    const marker = collapseConsecutiveDuplicates(lines).lines.find((l) => /ctrl\+o/.test(l));
    expect(marker).toBe('… +4 行相同（ctrl+o 展开）');
  });

  test('short runs (length < 3) stay verbatim — a marker would save nothing', () => {
    const lines = ['a', 'a', 'b']; // a run of 2 must NOT collapse
    const out = collapseConsecutiveDuplicates(lines);
    expect(out.collapsed).toBe(false);
    expect(out.hiddenCount).toBe(0);
    expect(out.lines).toEqual(['a', 'a', 'b']);
  });

  test('only CONSECUTIVE repeats collapse — non-adjacent duplicates are preserved', () => {
    // uniq-like, not a global de-dup: structure/order must survive.
    const lines = ['x', 'x', 'x', 'y', 'x', 'x', 'x'];
    const out = collapseConsecutiveDuplicates(lines);
    expect(out.lines).toEqual([
      'x',
      '… +2 行相同（ctrl+o 展开）',
      'y',
      'x',
      '… +2 行相同（ctrl+o 展开）',
    ]);
    expect(out.hiddenCount).toBe(4);
  });

  test('no repeats → input returned unchanged, collapsed=false', () => {
    const lines = ['one', 'two', 'three'];
    const out = collapseConsecutiveDuplicates(lines);
    expect(out.collapsed).toBe(false);
    expect(out.lines).toEqual(lines);
  });

  test('empty / non-array input is safe', () => {
    expect(collapseConsecutiveDuplicates([]).lines).toEqual([]);
    expect(collapseConsecutiveDuplicates(null).collapsed).toBe(false);
    expect(collapseConsecutiveDuplicates(undefined).lines).toEqual([]);
  });

  test('custom marker + minRun are honoured', () => {
    const lines = ['z', 'z', 'z', 'z'];
    const out = collapseConsecutiveDuplicates(lines, {
      minRun: 4,
      marker: (n) => `(x${n + 1})`,
    });
    // run of exactly 4 meets minRun=4 → collapses; marker sees repeats=3.
    expect(out.lines).toEqual(['z', '(x4)']);
  });
});
