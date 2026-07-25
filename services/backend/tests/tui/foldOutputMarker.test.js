'use strict';

/**
 * Regression lock for the Claude-Code-style fold marker produced by
 * toolDisplayPolicy.foldOutput — the SINGLE source of truth shared by the ink
 * TUI (ToolLines) and the classic REPL. GOAL 2 aligned this to CC's exact shape
 * ("… +N lines (ctrl+o to expand)" → localized "… +N 行 (ctrl+o 展开)").
 *
 * These assertions exist so a future edit cannot silently regress the marker
 * back to the abandoned "... +N 行 (ctrl+o 查看完整)" form: the visual contract
 * is (1) a SINGLE "…" ellipsis (not three ASCII dots), (2) the "+N" hidden count,
 * and (3) the "ctrl+o 展开" promise. Pure function — no ink, no async.
 */
const { foldOutput } = require('../../src/cli/toolDisplayPolicy');

describe('foldOutput — Claude Code fold marker (GOAL 2 regression lock)', () => {
  const policy = { maxLines: 20, foldHead: 12, foldTail: 6 };

  test('short output (<= maxLines) is returned IN FULL, never folded', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `keep${i + 1}`);
    const out = foldOutput(lines, policy);
    expect(out.folded).toBe(false);
    expect(out.hiddenCount).toBe(0);
    expect(out.lines).toEqual(lines); // untouched
  });

  test('long output folds to head + CC marker + tail with an honest hidden count', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const out = foldOutput(lines, policy);
    expect(out.folded).toBe(true);
    // 40 total - 12 head - 6 tail = 22 hidden.
    expect(out.hiddenCount).toBe(22);
    // Rendered shape: 12 head + 1 marker + 6 tail = 19 lines.
    expect(out.lines).toHaveLength(19);
    expect(out.lines[0]).toBe('line1'); // head preserved
    expect(out.lines[out.lines.length - 1]).toBe('line40'); // tail preserved
  });

  test('the marker is exactly CC style: single "…" ellipsis + "+N" + "ctrl+o 展开"', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    const marker = foldOutput(lines, policy).lines.find((l) => /ctrl\+o/.test(l));
    expect(marker).toBeDefined();
    // CC contract, locked verbatim.
    expect(marker).toBe('… +22 行 (ctrl+o 展开)');
    // Defence against the two abandoned forms.
    expect(marker.startsWith('…')).toBe(true); // single ellipsis, NOT "..."
    expect(marker).not.toContain('...'); // never three ASCII dots
    expect(marker).not.toContain('查看完整'); // never the old promise text
  });
});
