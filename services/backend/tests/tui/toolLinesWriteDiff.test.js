'use strict';

/**
 * buildWriteDiffRows — pure red/green ±diff row builder behind the ink TUI
 * tool renderer (ToolLines). This is the TUI half of the Goal7 write-diff
 * feature: the classic REPL rendered _khyWriteDiff via maybeRenderWriteDiff,
 * but the ink TUI (the default UI) never consumed it, so Write/Edit showed no
 * diff. These tests pin the row shape the ink renderer turns into
 * <Text color/backgroundColor> elements. No ink/React needed (pure helper).
 */

const {
  buildWriteDiffRows,
  buildShellDiffRows,
  looksLikeUnifiedDiff,
} = require('../../src/cli/tui/ink-components/ToolLines');

describe('buildWriteDiffRows', () => {
  test('returns null when there is no diff context', () => {
    expect(buildWriteDiffRows(null)).toBeNull();
    expect(buildWriteDiffRows(undefined)).toBeNull();
  });

  test('returns null when content is unchanged', () => {
    expect(buildWriteDiffRows({ beforeContent: 'x\ny', afterContent: 'x\ny' })).toBeNull();
  });

  test('new file → all-green add rows (防呆: creation shows +)', () => {
    const rows = buildWriteDiffRows({ filePath: 'a.js', beforeContent: '', afterContent: 'line1\nline2\n' });
    expect(rows).toEqual([
      { kind: 'add', num: 1, text: 'line1' },
      { kind: 'add', num: 2, text: 'line2' },
    ]);
    expect(rows.every((r) => r.kind === 'add')).toBe(true);
  });

  test('new file longer than preview cap shows a "+N lines" more row', () => {
    const after = Array.from({ length: 15 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const rows = buildWriteDiffRows({ beforeContent: '', afterContent: after });
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(10);
    const more = rows[rows.length - 1];
    expect(more.kind).toBe('more');
    expect(more.text).toContain('+5 lines');
  });

  // CC terminal.ts wrapText:42-60: a new file exactly ONE line over the cap inlines
  // that line rather than emitting a "+1 line" more row (the marker costs the same
  // terminal row as the line it hides). Gate KHY_PREVIEW_OVERFLOW_INLINE_ONE.
  test('new file exactly 1 over cap → inlines the 11th line, no more row (CC parity)', () => {
    const after = Array.from({ length: 11 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const rows = buildWriteDiffRows({ beforeContent: '', afterContent: after });
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(11); // all 11 shown
    expect(rows.some((r) => r.kind === 'more')).toBe(false); // no "+1 line" marker
  });

  test('gate KHY_PREVIEW_OVERFLOW_INLINE_ONE=0 → 11-line file falls back to "+1 line" marker', () => {
    const prev = process.env.KHY_PREVIEW_OVERFLOW_INLINE_ONE;
    process.env.KHY_PREVIEW_OVERFLOW_INLINE_ONE = '0';
    try {
      const after = Array.from({ length: 11 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
      const rows = buildWriteDiffRows({ beforeContent: '', afterContent: after });
      expect(rows.filter((r) => r.kind === 'add')).toHaveLength(10);
      const more = rows[rows.length - 1];
      expect(more.kind).toBe('more');
      expect(more.text).toContain('+1 line'); // singular (plural guard still on)
    } finally {
      if (prev === undefined) delete process.env.KHY_PREVIEW_OVERFLOW_INLINE_ONE;
      else process.env.KHY_PREVIEW_OVERFLOW_INLINE_ONE = prev;
    }
  });

  test('deleted file → all-red remove rows (防呆: deletion shows −)', () => {
    const rows = buildWriteDiffRows({ filePath: 'a.js', beforeContent: 'old1\nold2\n', afterContent: '' });
    expect(rows).toEqual([
      { kind: 'del', num: 1, text: 'old1' },
      { kind: 'del', num: 2, text: 'old2' },
    ]);
    expect(rows.every((r) => r.kind === 'del')).toBe(true);
  });

  test('existing file edit → context + red/green + stat footer', () => {
    const rows = buildWriteDiffRows({ beforeContent: 'a\nb\nc\n', afterContent: 'a\nB\nc\n' });
    expect(rows).toEqual([
      { kind: 'ctx', num: 1, text: 'a' },
      { kind: 'del', num: 2, text: 'b' },
      { kind: 'add', num: 2, text: 'B' },
      { kind: 'ctx', num: 3, text: 'c' },
      { kind: 'stat', text: '└ Added 1 line, removed 1 line' },
    ]);
  });

  test('diff rows preserve leading indentation (must not collapse whitespace)', () => {
    const rows = buildWriteDiffRows({
      beforeContent: 'function f() {\n  return 1;\n}\n',
      afterContent: 'function f() {\n    return 2;\n}\n',
    });
    const addRow = rows.find((r) => r.kind === 'add');
    expect(addRow.text).toBe('    return 2;'); // 4-space indent intact
    const delRow = rows.find((r) => r.kind === 'del');
    expect(delRow.text).toBe('  return 1;');
  });

  test('large edit caps inline rows and emits a truncation marker', () => {
    const before = Array.from({ length: 200 }, (_, i) => `old${i}`).join('\n') + '\n';
    const after = Array.from({ length: 200 }, (_, i) => `new${i}`).join('\n') + '\n';
    const rows = buildWriteDiffRows({ beforeContent: before, afterContent: after });
    const truncMarker = rows.find((r) => r.kind === 'more' && /truncated/.test(r.text));
    expect(truncMarker).toBeTruthy();
    // Body rows (excluding the trailing stat) stay within the safety cap + marker.
    const body = rows.filter((r) => r.kind !== 'stat');
    expect(body.length).toBeLessThanOrEqual(61);
  });

  // P2 multi-hunk: two edits far apart must render as SEPARATE hunks with a gap
  // marker, and the stat must count only the real changes (not the whole span
  // between them, which the old prefix/suffix-collapse over-counted).
  test('two distant edits render as two hunks with a gap and an accurate stat', () => {
    const before = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const after = before.replace('L2\n', 'L2x\n').replace('L25\n', 'L25x\n');
    const rows = buildWriteDiffRows({ beforeContent: before, afterContent: after });
    // Exactly one gap separator between the two hunks.
    const gaps = rows.filter((r) => r.kind === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].text).toMatch(/unchanged line/);
    // Both edits are present, del-before-add in each block.
    expect(rows).toEqual(expect.arrayContaining([
      { kind: 'del', num: 2, text: 'L2' },
      { kind: 'add', num: 2, text: 'L2x' },
      { kind: 'del', num: 25, text: 'L25' },
      { kind: 'add', num: 25, text: 'L25x' },
    ]));
    // Stat counts the 2 real changes, NOT the ~23-line span between them.
    const stat = rows.find((r) => r.kind === 'stat');
    expect(stat.text).toBe('└ Added 2 lines, removed 2 lines');
    // The unchanged island (L3..L24) is elided, not rendered line-by-line.
    expect(rows.some((r) => r.kind === 'ctx' && r.text === 'L15')).toBe(false);
  });

  test('a single localized edit stays one hunk (no gap marker)', () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const after = before.replace('L10\n', 'L10x\n');
    const rows = buildWriteDiffRows({ beforeContent: before, afterContent: after });
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    expect(rows.find((r) => r.kind === 'stat').text).toBe('└ Added 1 line, removed 1 line');
  });

  // 2.2 expansion honesty: the "ctrl+o to expand" promise must be REAL — pressing
  // it (expanded:true) reveals more rows. And the hint only appears while folded.
  test('a new-file preview reveals more lines when expanded (honest ctrl+o)', () => {
    const after = Array.from({ length: 15 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const collapsed = buildWriteDiffRows({ beforeContent: '', afterContent: after }, false);
    const expanded = buildWriteDiffRows({ beforeContent: '', afterContent: after }, true);
    // Collapsed: 10 lines + a "ctrl+o to expand" more row.
    expect(collapsed.filter((r) => r.kind === 'add')).toHaveLength(10);
    expect(collapsed.some((r) => r.kind === 'more' && /ctrl\+o/.test(r.text))).toBe(true);
    // Expanded: all 15 lines, no "ctrl+o" promise (nothing left to expand to).
    expect(expanded.filter((r) => r.kind === 'add')).toHaveLength(15);
    expect(expanded.some((r) => /ctrl\+o/.test(r.text || ''))).toBe(false);
  });

  test('a large edit reveals far more rows when expanded, and drops the ctrl+o hint', () => {
    const before = Array.from({ length: 400 }, (_, i) => `old${i}`).join('\n') + '\n';
    const after = Array.from({ length: 400 }, (_, i) => `new${i}`).join('\n') + '\n';
    const collapsed = buildWriteDiffRows({ beforeContent: before, afterContent: after }, false);
    const expanded = buildWriteDiffRows({ beforeContent: before, afterContent: after }, true);
    // Expanded shows strictly more body rows than collapsed (the cap actually rose).
    const bodyLen = (rows) => rows.filter((r) => r.kind !== 'stat' && r.kind !== 'more').length;
    expect(bodyLen(expanded)).toBeGreaterThan(bodyLen(collapsed));
    // Collapsed promises ctrl+o; expanded never makes a promise it can't keep.
    expect(collapsed.some((r) => /ctrl\+o/.test(r.text || ''))).toBe(true);
    expect(expanded.some((r) => /ctrl\+o/.test(r.text || ''))).toBe(false);
  });
});

// ── D: shell/git output inline ±diff colouring (mirrors the classic REPL's
// maybeRenderInlineDiffFromToolOutput, previously absent from the TUI) ──

describe('looksLikeUnifiedDiff', () => {
  test('detects +/- and @@ hunk markers', () => {
    expect(looksLikeUnifiedDiff('@@ -1,2 +1,2 @@\n-old\n+new')).toBe(true);
    expect(looksLikeUnifiedDiff('--- a/x\n+++ b/x')).toBe(true);
    expect(looksLikeUnifiedDiff('-removed line\n context')).toBe(true);
  });

  test('does not misfire on ordinary command output', () => {
    expect(looksLikeUnifiedDiff('total 4\ndrwxr-xr-x 2 user group')).toBe(false);
    expect(looksLikeUnifiedDiff('Done.')).toBe(false);
    expect(looksLikeUnifiedDiff('')).toBe(false);
  });

  test('a leading ++/-- bullet list is not treated as a diff body', () => {
    // "+++"/"---" as headers ARE diff markers, but a single "++" must not.
    expect(looksLikeUnifiedDiff('++not a diff')).toBe(false);
  });
});

describe('buildShellDiffRows', () => {
  test('classifies headers, adds, dels and context', () => {
    const out = [
      'diff --git a/f.js b/f.js',
      '--- a/f.js',
      '+++ b/f.js',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
      '-removed',
      '+added',
    ].join('\n');
    const rows = buildShellDiffRows(out);
    // Line numbers (KHY_DIFF_LINE_NUMBERS default on): @@ -1,3 +1,3 @@ seeds old=1,new=1.
    // ctx 'unchanged' → new line 1; del 'removed' → old line 2; add 'added' → new line 2.
    // Headers (meta) carry no num. Mirrors write-diff computeStructuredDiffHunks gutter.
    expect(rows).toEqual([
      { kind: 'meta', text: 'diff --git a/f.js b/f.js' },
      { kind: 'meta', text: '--- a/f.js' },
      { kind: 'meta', text: '+++ b/f.js' },
      { kind: 'meta', text: '@@ -1,3 +1,3 @@' },
      { kind: 'ctx', text: 'unchanged', num: 1 },
      { kind: 'del', text: 'removed', num: 2 },
      { kind: 'add', text: 'added', num: 2 },
    ]);
  });

  test('numbers across multiple hunks, each header reseeding old/new cursors', () => {
    const out = [
      '@@ -10,2 +10,2 @@',
      ' ctxA',
      '-delA',
      '+addA',
      '@@ -50,1 +60,2 @@',
      '+addB',
      ' ctxB',
    ].join('\n');
    const rows = buildShellDiffRows(out).filter((r) => r.kind !== 'meta');
    expect(rows).toEqual([
      { kind: 'ctx', text: 'ctxA', num: 10 }, // new line 10
      { kind: 'del', text: 'delA', num: 11 }, // old line 11 (10→11 after ctx)
      { kind: 'add', text: 'addA', num: 11 }, // new line 11
      { kind: 'add', text: 'addB', num: 60 }, // second hunk reseeds new=60
      { kind: 'ctx', text: 'ctxB', num: 61 }, // new line 61
    ]);
  });

  test('routes `\\ No newline at end of file` marker to meta (no bogus num / no cursor shift)', () => {
    // git emits this marker when a changed region touches a newline-less last
    // line. It is NOT file content: it must render dim (meta) with no gutter
    // number, and must not advance the old/new cursors — otherwise every row
    // after it in the hunk shows a line number off by one.
    const out = [
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '\\ No newline at end of file',
      '+line2',
      ' line3',
    ].join('\n');
    const rows = buildShellDiffRows(out);
    expect(rows).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'ctx', text: 'line1', num: 1 },
      { kind: 'del', text: 'line2', num: 2 },
      { kind: 'meta', text: '\\ No newline at end of file' }, // dim, no num
      { kind: 'add', text: 'line2', num: 2 }, // NOT 3
      { kind: 'ctx', text: 'line3', num: 3 }, // NOT 4
    ]);
  });

  test('gate KHY_DIFF_LINE_NUMBERS off → no num assigned (byte fallback)', () => {
    const saved = process.env.KHY_DIFF_LINE_NUMBERS;
    process.env.KHY_DIFF_LINE_NUMBERS = '0';
    try {
      const out = '@@ -1,2 +1,2 @@\n unchanged\n-removed\n+added';
      const rows = buildShellDiffRows(out);
      for (const r of rows) {
        expect(r.num).toBeUndefined();
      }
    } finally {
      if (saved === undefined) delete process.env.KHY_DIFF_LINE_NUMBERS;
      else process.env.KHY_DIFF_LINE_NUMBERS = saved;
    }
  });

  test('strips only the single +/- marker, preserving code indentation', () => {
    const rows = buildShellDiffRows('+    indented();\n-  other();');
    expect(rows.find((r) => r.kind === 'add').text).toBe('    indented();');
    expect(rows.find((r) => r.kind === 'del').text).toBe('  other();');
  });

  test('caps very large diffs with a truncation marker', () => {
    const big = Array.from({ length: 200 }, (_, i) => `+line${i}`).join('\n');
    const rows = buildShellDiffRows(big);
    const more = rows.find((r) => r.kind === 'more' && /truncated/.test(r.text));
    expect(more).toBeTruthy();
    expect(rows.length).toBeLessThanOrEqual(61);
  });

  test('returns null on empty input', () => {
    expect(buildShellDiffRows('')).toBeNull();
  });
});
