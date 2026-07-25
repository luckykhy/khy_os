'use strict';

// 对齐 CC「后端逻辑也对齐」:ink TUI diff 内容列的**裁切宽度**逻辑
// (CC src/components/StructuredDiff/Fallback.tsx::formatDiff)。核心后端逻辑 =
//   availableContentWidth = max(1, safeWidth - maxWidth - 1 - diffPrefixWidth)
//   + wrapText(code, availableContentWidth, 'wrap') —— 按**终端宽度**算每行内容预算,
//   长行**换行**铺开绝不丢内容。Khy 历史是恒 100 字 `clip(text,100)` 硬截,无视终端宽度
//   且**展开(Ctrl+O)后仍截**。钉住:门控关 = 恒 100 逐字节回退;门控开折叠 = 按列宽单行预算;
//   门控开展开 = Infinity(=不裁,交 ink 换行)。
const test = require('node:test');
const assert = require('node:assert');
const { diffContentWidthEnabled, diffClipWidth, LEGACY_CLIP } = require('../../src/cli/diffContentWidth');

test('gate ladder: default/unset → on; 0/false/off/no → off (case-insensitive)', () => {
  assert.strictEqual(diffContentWidthEnabled({}), true);
  assert.strictEqual(diffContentWidthEnabled({ KHY_DIFF_CONTENT_WIDTH: '' }), true);
  assert.strictEqual(diffContentWidthEnabled({ KHY_DIFF_CONTENT_WIDTH: '1' }), true);
  assert.strictEqual(diffContentWidthEnabled({ KHY_DIFF_CONTENT_WIDTH: 'yes' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO']) {
    assert.strictEqual(diffContentWidthEnabled({ KHY_DIFF_CONTENT_WIDTH: v }), false);
  }
});

test('gate off → LEGACY_CLIP (100) regardless of columns/expanded (byte fallback)', () => {
  const off = { KHY_DIFF_CONTENT_WIDTH: '0' };
  assert.strictEqual(LEGACY_CLIP, 100);
  assert.strictEqual(diffClipWidth({ columns: 200, gutterWidth: 4, expanded: false, env: off }), 100);
  assert.strictEqual(diffClipWidth({ columns: 200, gutterWidth: 4, expanded: true, env: off }), 100);
  assert.strictEqual(diffClipWidth({ columns: 40, gutterWidth: 2, expanded: false, env: off }), 100);
});

test('gate on + expanded → Infinity (no clip → ink wraps full content, CC no-loss)', () => {
  const on = {};
  assert.strictEqual(diffClipWidth({ columns: 80, gutterWidth: 2, expanded: true, env: on }), Infinity);
  assert.strictEqual(diffClipWidth({ columns: 200, gutterWidth: 5, expanded: true, env: on }), Infinity);
  // expanded clip(s, Infinity) === s contract: length never exceeds Infinity.
  assert.ok(!('x'.repeat(99999).length > Infinity));
});

test('gate on + collapsed → terminal-width-aware budget = max(20, cols - gw - 3 - 3)', () => {
  const on = {};
  // 80 cols, gutter 2 → 80 - 2 - 3 - 3 = 72.
  assert.strictEqual(diffClipWidth({ columns: 80, gutterWidth: 2, expanded: false, env: on }), 72);
  // 200 cols, gutter 4 → 200 - 4 - 6 = 190 (wider than legacy 100, shows more).
  assert.strictEqual(diffClipWidth({ columns: 200, gutterWidth: 4, expanded: false, env: on }), 190);
  // 120 cols, gutter 3 → 111.
  assert.strictEqual(diffClipWidth({ columns: 120, gutterWidth: 3, expanded: false, env: on }), 111);
});

test('narrow terminal floored at MIN_CONTENT (20) so something is always shown', () => {
  const on = {};
  // 24 cols, gutter 2 → 24 - 2 - 6 = 16 → floored to 20.
  assert.strictEqual(diffClipWidth({ columns: 24, gutterWidth: 2, expanded: false, env: on }), 20);
  assert.strictEqual(diffClipWidth({ columns: 1, gutterWidth: 4, expanded: false, env: on }), 20);
});

test('unknown / invalid columns → DEFAULT_COLUMNS (80); invalid gutter → 1', () => {
  const on = {};
  // columns undefined → 80; gutter 1 → 80 - 1 - 6 = 73.
  assert.strictEqual(diffClipWidth({ gutterWidth: 1, expanded: false, env: on }), 73);
  assert.strictEqual(diffClipWidth({ columns: 0, gutterWidth: 1, expanded: false, env: on }), 73);
  assert.strictEqual(diffClipWidth({ columns: -5, gutterWidth: 1, expanded: false, env: on }), 73);
  assert.strictEqual(diffClipWidth({ columns: NaN, gutterWidth: 1, expanded: false, env: on }), 73);
  // gutter undefined/invalid → treated as 1 → 80 - 1 - 6 = 73.
  assert.strictEqual(diffClipWidth({ columns: 80, expanded: false, env: on }), 73);
  assert.strictEqual(diffClipWidth({ columns: 80, gutterWidth: 0, expanded: false, env: on }), 73);
});

test('no-arg / empty opts default to enabled collapsed 80-col budget (defensive)', () => {
  // env defaults to process.env (unset KHY_DIFF_CONTENT_WIDTH → on); columns/gutter fallback.
  const w = diffClipWidth({});
  assert.ok(w === 73 || (typeof w === 'number' && w >= 20));
});

test('default-on parity: omitting env reads process.env (gate default on → not 100 by accident)', () => {
  const prev = process.env.KHY_DIFF_CONTENT_WIDTH;
  delete process.env.KHY_DIFF_CONTENT_WIDTH;
  try {
    assert.strictEqual(diffClipWidth({ columns: 80, gutterWidth: 2, expanded: true }), Infinity);
    assert.strictEqual(diffClipWidth({ columns: 80, gutterWidth: 2, expanded: false }), 72);
  } finally {
    if (prev === undefined) delete process.env.KHY_DIFF_CONTENT_WIDTH;
    else process.env.KHY_DIFF_CONTENT_WIDTH = prev;
  }
});
