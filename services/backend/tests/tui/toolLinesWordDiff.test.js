'use strict';

/**
 * planWordDiffPairs / tuiWordDiffEnabled — the TUI half of word-level (intra-line)
 * diff highlighting. The classic ANSI paths (diffRenderer.renderStructuredDiff /
 * renderDiff) already highlight changed sub-spans via wordDiff.renderWordDiffLine,
 * but the ink TUI only ever coloured whole ±lines. These tests pin the pairing &
 * segment plan the ink renderer turns into <Text backgroundColor> spans, and the
 * default-on gate's byte-identical fallback. Pure helpers — no ink/React needed.
 *
 * Mirrors CC StructuredDiffFallback.processAdjacentLines: a run of consecutive
 * `del` rows immediately followed by a run of `add` rows is paired 1:1; only pairs
 * whose change ratio is at/below threshold get word-level segments.
 */

const {
  planWordDiffPairs,
  tuiWordDiffEnabled,
} = require('../../src/cli/tui/ink-components/ToolLines');
const wd = require('../../src/cli/wordDiff');

function joinSegs(segs) {
  return segs.map((s) => s.text).join('');
}

describe('tuiWordDiffEnabled (gate, default on)', () => {
  test('default (unset) → on', () => {
    expect(tuiWordDiffEnabled({})).toBe(true);
  });
  test.each(['0', 'false', 'off', 'no', 'FALSE', 'Off'])('=%s → off', (v) => {
    expect(tuiWordDiffEnabled({ KHY_TUI_WORD_DIFF: v })).toBe(false);
  });
  test('any other value → on', () => {
    expect(tuiWordDiffEnabled({ KHY_TUI_WORD_DIFF: '1' })).toBe(true);
    expect(tuiWordDiffEnabled({ KHY_TUI_WORD_DIFF: 'yes' })).toBe(true);
  });
});

describe('planWordDiffPairs', () => {
  test('adjacent del→add pair with a small change → both indices planned', () => {
    const rows = [
      { kind: 'ctx', num: 1, text: 'a' },
      { kind: 'del', num: 2, text: 'return oldName(p);' },
      { kind: 'add', num: 2, text: 'return newName(p);' },
      { kind: 'ctx', num: 3, text: 'b' },
    ];
    const plan = planWordDiffPairs(rows, wd);
    expect([...plan.keys()].sort()).toEqual([1, 2]);
    expect(plan.get(1).side).toBe('del');
    expect(plan.get(2).side).toBe('add');
    expect(joinSegs(plan.get(1).segs)).toBe('return oldName(p);');
    expect(joinSegs(plan.get(2).segs)).toBe('return newName(p);');
    expect(plan.get(1).segs.filter((s) => s.changed).map((s) => s.text)).toEqual(['oldName']);
    expect(plan.get(2).segs.filter((s) => s.changed).map((s) => s.text)).toEqual(['newName']);
  });

  test('heavily-changed pair → no plan entry (renderer keeps solid line)', () => {
    const rows = [
      { kind: 'del', num: 1, text: 'alpha beta gamma' },
      { kind: 'add', num: 1, text: 'one two three four five' },
    ];
    const plan = planWordDiffPairs(rows, wd);
    expect(plan.size).toBe(0);
  });

  test('del with no following add → not paired', () => {
    const rows = [
      { kind: 'del', num: 1, text: 'gone line' },
      { kind: 'ctx', num: 2, text: 'unchanged' },
    ];
    expect(planWordDiffPairs(rows, wd).size).toBe(0);
  });

  test('unequal run lengths → only min(count) pairs; extras unplanned', () => {
    // 2 dels, 1 add → only the first del pairs with the add. Lines kept long
    // enough that a single-word change stays under CHANGE_THRESHOLD.
    const rows = [
      { kind: 'del', num: 1, text: 'foo bar aaa baz' },
      { kind: 'del', num: 2, text: 'foo bar ccc baz' },
      { kind: 'add', num: 1, text: 'foo bar zzz baz' },
    ];
    const plan = planWordDiffPairs(rows, wd);
    expect([...plan.keys()].sort()).toEqual([0, 2]); // del#0 ↔ add#2
    expect(plan.has(1)).toBe(false); // second del unpaired
  });

  test('two separate del→add blocks each get paired', () => {
    const rows = [
      { kind: 'del', num: 1, text: 'keep this aaa here' },
      { kind: 'add', num: 1, text: 'keep this bbb here' },
      { kind: 'ctx', num: 2, text: 'mid' },
      { kind: 'del', num: 3, text: 'also keep ccc line' },
      { kind: 'add', num: 3, text: 'also keep ddd line' },
    ];
    const plan = planWordDiffPairs(rows, wd);
    expect([...plan.keys()].sort((a, b) => a - b)).toEqual([0, 1, 3, 4]);
  });

  test('null/empty wd or rows → empty plan (defensive)', () => {
    expect(planWordDiffPairs(null, wd).size).toBe(0);
    expect(planWordDiffPairs([], wd).size).toBe(0);
    expect(planWordDiffPairs([{ kind: 'del', text: 'x' }, { kind: 'add', text: 'y' }], null).size).toBe(0);
    expect(planWordDiffPairs([{ kind: 'del', text: 'x' }], {}).size).toBe(0); // wd missing method
  });

  test('segments are clipped to the same width bound as the legacy line render', () => {
    const longA = 'x'.repeat(140) + ' tail_a';
    const longB = 'x'.repeat(140) + ' tail_b';
    const rows = [
      { kind: 'del', num: 1, text: longA },
      { kind: 'add', num: 1, text: longB },
    ];
    const plan = planWordDiffPairs(rows, wd);
    // clip(_, 100) → ≤100 chars per side, matching `${num} - ${clip(text,100)}`.
    if (plan.has(0)) {
      expect(joinSegs(plan.get(0).segs).length).toBeLessThanOrEqual(100);
    }
    if (plan.has(1)) {
      expect(joinSegs(plan.get(1).segs).length).toBeLessThanOrEqual(100);
    }
  });

  test('clipW param (刀15): default 100, Infinity = no truncation, narrow = tighter', () => {
    // A near-identical pair that survives the change-ratio threshold even when long,
    // so a plan entry exists regardless of width (single-token tail change).
    const a = 'k'.repeat(200) + ' aaa';
    const b = 'k'.repeat(200) + ' bbb';
    const rows = () => [
      { kind: 'del', num: 1, text: a },
      { kind: 'add', num: 1, text: b },
    ];
    // Default clipW (omitted) === 100 → byte-identical legacy bound.
    const dflt = planWordDiffPairs(rows(), wd);
    if (dflt.has(0)) expect(joinSegs(dflt.get(0).segs).length).toBeLessThanOrEqual(100);
    // Infinity (expanded, Ctrl+O) → segments carry the FULL line, no truncation.
    const wide = planWordDiffPairs(rows(), wd, Infinity);
    if (wide.has(0)) {
      expect(joinSegs(wide.get(0).segs).length).toBe(a.length);
      expect(joinSegs(wide.get(1).segs).length).toBe(b.length);
    }
    // Narrow collapsed budget → tighter than legacy 100.
    const narrow = planWordDiffPairs(rows(), wd, 40);
    if (narrow.has(0)) expect(joinSegs(narrow.get(0).segs).length).toBeLessThanOrEqual(40);
  });
});
