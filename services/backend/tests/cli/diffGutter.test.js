'use strict';

// 对齐 CC「后端逻辑也对齐」:结构化 diff 行号 gutter 的**宽度计算逻辑**
// (CC src/components/StructuredDiff.tsx::computeGutterWidth)。核心后端逻辑 =
//   gutter 数字位宽 = Math.max(maxLineNumber, 1).toString().length —— 右对齐到本
//   diff 实际出现的最大行号位数(至少 1 位),而非 Khy 历史的恒 4 位 padStart(4)。
// 钉住:门控开 = CC 动态位宽;门控关 = 逐字节回退恒 4 位 legacy。
const test = require('node:test');
const assert = require('node:assert');

const {
  diffGutterWidthEnabled,
  computeDiffGutterWidth,
  computeDiffGutterWidthForMax,
  formatDiffGutterNum,
} = require('../../src/cli/diffGutter');

const ON = { KHY_DIFF_GUTTER_WIDTH: '1' };
const OFF = { KHY_DIFF_GUTTER_WIDTH: 'off' };

// ── 门控梯 ─────────────────────────────────────────────────────────────────────
test('diffGutterWidthEnabled:默认开,仅 0/false/off/no 关', () => {
  assert.strictEqual(diffGutterWidthEnabled({}), true);
  assert.strictEqual(diffGutterWidthEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.strictEqual(diffGutterWidthEnabled({ KHY_DIFF_GUTTER_WIDTH: v }), false, v);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
    assert.strictEqual(diffGutterWidthEnabled({ KHY_DIFF_GUTTER_WIDTH: v }), true, v);
  }
});

// ── computeDiffGutterWidthForMax:CC 动态位宽(单块路径)──────────────────────────
test('门控开:位宽 = 最大行号的位数(CC 规则)', () => {
  assert.strictEqual(computeDiffGutterWidthForMax(5, ON), 1);     // 小文件比 4 更窄
  assert.strictEqual(computeDiffGutterWidthForMax(50, ON), 2);
  assert.strictEqual(computeDiffGutterWidthForMax(999, ON), 3);
  assert.strictEqual(computeDiffGutterWidthForMax(1000, ON), 4);
  assert.strictEqual(computeDiffGutterWidthForMax(12345, ON), 5); // 比 4 更宽,修对齐
});

test('门控开:CC 的 Math.max(maxLineNumber,1) → 至少 1 位', () => {
  assert.strictEqual(computeDiffGutterWidthForMax(0, ON), 1);
  assert.strictEqual(computeDiffGutterWidthForMax(-3, ON), 1);
  assert.strictEqual(computeDiffGutterWidthForMax(NaN, ON), 1);
  assert.strictEqual(computeDiffGutterWidthForMax(undefined, ON), 1);
});

test('门控关:computeDiffGutterWidthForMax 恒 4(逐字节回退)', () => {
  for (const n of [5, 50, 999, 1000, 12345, 0, -3, NaN]) {
    assert.strictEqual(computeDiffGutterWidthForMax(n, OFF), 4, String(n));
  }
});

// ── computeDiffGutterWidth:从行模型推位宽(多 hunk 路径)─────────────────────────
test('门控开:取所有 num 行的最大位数', () => {
  const rows = [
    { kind: 'ctx', num: 1, text: 'a' },
    { kind: 'del', num: 2, text: 'b' },
    { kind: 'add', num: 25, text: 'B' },   // 2 位
    { kind: 'meta', text: '@@' },           // 无 num,忽略
  ];
  assert.strictEqual(computeDiffGutterWidth(rows, ON), 2);
});

test('门控开:hunk 跨位数边界 9998→10002 → 取 5 位(修 padStart(4) 错位)', () => {
  const rows = [
    { kind: 'ctx', num: 9998, text: 'a' },
    { kind: 'del', num: 9999, text: 'b' },
    { kind: 'add', num: 10002, text: 'B' }, // 5 位 → 全列对齐到 5
  ];
  assert.strictEqual(computeDiffGutterWidth(rows, ON), 5);
});

test('门控开:无任何 num 行(如行号关)→ 回退 legacy 4 位填充', () => {
  const rows = [
    { kind: 'ctx', text: 'a' },
    { kind: 'add', text: 'B' },
  ];
  assert.strictEqual(computeDiffGutterWidth(rows, ON), 4);
  assert.strictEqual(computeDiffGutterWidth([], ON), 4);
  assert.strictEqual(computeDiffGutterWidth(undefined, ON), 4);
});

test('门控关:computeDiffGutterWidth 恒 4(逐字节回退)', () => {
  const rows = [{ kind: 'add', num: 12345, text: 'x' }];
  assert.strictEqual(computeDiffGutterWidth(rows, OFF), 4);
});

// ── formatDiffGutterNum:右对齐 + null 填充 ──────────────────────────────────────
test('formatDiffGutterNum:数字右对齐到 width,null → 等宽空白填充', () => {
  assert.strictEqual(formatDiffGutterNum(5, 1), '5');
  assert.strictEqual(formatDiffGutterNum(5, 4), '   5');   // legacy 宽 = padStart(4)
  assert.strictEqual(formatDiffGutterNum(12345, 5), '12345');
  assert.strictEqual(formatDiffGutterNum(null, 4), '    '); // 4 空格 = legacy '    '
  assert.strictEqual(formatDiffGutterNum(undefined, 2), '  ');
});

test('formatDiffGutterNum:非法 width → 退 legacy 4', () => {
  assert.strictEqual(formatDiffGutterNum(5, 0), '   5');
  assert.strictEqual(formatDiffGutterNum(5, NaN), '   5');
  assert.strictEqual(formatDiffGutterNum(null, -1), '    ');
});

// ── 门控关 = 历史 padStart(4) 逐字节等价(组合验证)─────────────────────────────
test('门控关组合:formatDiffGutterNum(num, computeDiffGutterWidth(rows, OFF)) === String(num).padStart(4)', () => {
  const rows = [
    { kind: 'ctx', num: 1, text: 'a' },
    { kind: 'add', num: 12345, text: 'b' },
    { kind: 'meta', text: '@@' },
  ];
  const w = computeDiffGutterWidth(rows, OFF);
  for (const r of rows) {
    const legacy = r.num != null ? String(r.num).padStart(4) : '    ';
    assert.strictEqual(formatDiffGutterNum(r.num, w), legacy, JSON.stringify(r));
  }
});

// ── 默认 env(无显式门控)= 开档 ───────────────────────────────────────────────
test('默认 process.env(无 KHY_DIFF_GUTTER_WIDTH)= 开档动态位宽', () => {
  const saved = process.env.KHY_DIFF_GUTTER_WIDTH;
  delete process.env.KHY_DIFF_GUTTER_WIDTH;
  try {
    assert.strictEqual(computeDiffGutterWidthForMax(7), 1);
    assert.strictEqual(computeDiffGutterWidthForMax(12345), 5);
  } finally {
    if (saved !== undefined) process.env.KHY_DIFF_GUTTER_WIDTH = saved;
  }
});
