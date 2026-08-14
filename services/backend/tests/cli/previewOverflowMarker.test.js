'use strict';

// previewOverflowMarker pure-leaf tests — diff/预览溢出折叠标记的文本构造 +
// 复数守卫(CC `=== 1` 约定)单一真源。node:test(jest 在 rtk 下损坏)。
//
// 关键验收:
//   - 门控开 N>1 → 与历史逐字节一致(`+5 lines`/`5 more rows`)。
//   - 门控开 N===1 → 守单数(`+1 line`/`1 more row`)=本刀修复点。
//   - 门控关 → 恒复数(`+1 lines`/`1 more rows`)= legacy 字节回退。
//   - expanded 切 `(capped)` / `capped`;sign 只认 `-`,其余归 `+`;非有限 → 0。

const test = require('node:test');
const assert = require('node:assert');

const m = require('../../src/cli/previewOverflowMarker');

const ON = {}; // 默认开
const OFF = { KHY_PREVIEW_OVERFLOW_PLURAL: '0' };
const INLINE_OFF = { KHY_PREVIEW_OVERFLOW_INLINE_ONE: '0' };

// ── 门控梯 ──────────────────────────────────────────────────────────────────
test('previewOverflowPluralEnabled: 默认开', () => {
  assert.equal(m.previewOverflowPluralEnabled(ON), true);
  assert.equal(m.previewOverflowPluralEnabled(undefined), true);
});

test('previewOverflowPluralEnabled: 0/false/off/no → 关(大小写/空白不敏感)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(m.previewOverflowPluralEnabled({ KHY_PREVIEW_OVERFLOW_PLURAL: v }), false, `value ${v}`);
  }
});

// ── buildLinesOverflow ──────────────────────────────────────────────────────
test('buildLinesOverflow: 折叠态 N>1 → 与历史逐字节一致(复数 + ctrl+o)', () => {
  assert.equal(m.buildLinesOverflow(5, '+', false, ON), '... +5 lines (ctrl+o to expand)');
  assert.equal(m.buildLinesOverflow(12, '-', false, ON), '... -12 lines (ctrl+o to expand)');
});

test('buildLinesOverflow: 展开态 N>1 → (capped)', () => {
  assert.equal(m.buildLinesOverflow(5, '+', true, ON), '... +5 lines (capped)');
  assert.equal(m.buildLinesOverflow(3, '-', true, ON), '... -3 lines (capped)');
});

test('buildLinesOverflow: 门控开 N===1 → 守单数 line(本刀修复点)', () => {
  assert.equal(m.buildLinesOverflow(1, '+', false, ON), '... +1 line (ctrl+o to expand)');
  assert.equal(m.buildLinesOverflow(1, '-', true, ON), '... -1 line (capped)');
});

test('buildLinesOverflow: 门控关 N===1 → 恒复数 lines(legacy 字节回退)', () => {
  assert.equal(m.buildLinesOverflow(1, '+', false, OFF), '... +1 lines (ctrl+o to expand)');
  assert.equal(m.buildLinesOverflow(1, '-', true, OFF), '... -1 lines (capped)');
});

test('buildLinesOverflow: 门控开/关唯一分歧 = N===1 的单复数', () => {
  // N>1 两态必须逐字节一致(历史本就复数)。
  assert.equal(m.buildLinesOverflow(7, '+', false, ON), m.buildLinesOverflow(7, '+', false, OFF));
  // N===1 两态唯一不同。
  assert.notEqual(m.buildLinesOverflow(1, '+', false, ON), m.buildLinesOverflow(1, '+', false, OFF));
});

test('buildLinesOverflow: sign 只认 `-`,其余归 `+`', () => {
  assert.equal(m.buildLinesOverflow(2, '+', false, ON), '... +2 lines (ctrl+o to expand)');
  assert.equal(m.buildLinesOverflow(2, 'x', false, ON), '... +2 lines (ctrl+o to expand)');
  assert.equal(m.buildLinesOverflow(2, undefined, false, ON), '... +2 lines (ctrl+o to expand)');
});

test('buildLinesOverflow: 防呆 非有限 N → 0(并按复数)', () => {
  assert.equal(m.buildLinesOverflow(NaN, '+', false, ON), '... +0 lines (ctrl+o to expand)');
  assert.equal(m.buildLinesOverflow(undefined, '+', false, ON), '... +0 lines (ctrl+o to expand)');
});

// ── buildRowsOverflow ───────────────────────────────────────────────────────
test('buildRowsOverflow: 折叠态 N>1 → 与历史逐字节一致', () => {
  assert.equal(m.buildRowsOverflow(8, false, ON), '... (diff truncated, 8 more rows, ctrl+o to expand)');
});

test('buildRowsOverflow: 展开态 N>1 → capped', () => {
  assert.equal(m.buildRowsOverflow(8, true, ON), '... (diff truncated, 8 more rows, capped)');
});

test('buildRowsOverflow: 门控开 N===1 → 守单数 row(本刀修复点)', () => {
  assert.equal(m.buildRowsOverflow(1, false, ON), '... (diff truncated, 1 more row, ctrl+o to expand)');
  assert.equal(m.buildRowsOverflow(1, true, ON), '... (diff truncated, 1 more row, capped)');
});

test('buildRowsOverflow: 门控关 N===1 → 恒复数 rows(legacy 字节回退)', () => {
  assert.equal(m.buildRowsOverflow(1, false, OFF), '... (diff truncated, 1 more rows, ctrl+o to expand)');
});

test('buildRowsOverflow: 防呆 非有限 → 0', () => {
  assert.equal(m.buildRowsOverflow(NaN, false, ON), '... (diff truncated, 0 more rows, ctrl+o to expand)');
});

// ── resolveFold(CC terminal.ts wrapText:42-60 内联单行规则)────────────────────
test('foldInlineSingleEnabled: 默认开 / 0·false·off·no → 关', () => {
  assert.equal(m.foldInlineSingleEnabled(ON), true);
  assert.equal(m.foldInlineSingleEnabled(undefined), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(m.foldInlineSingleEnabled({ KHY_PREVIEW_OVERFLOW_INLINE_ONE: v }), false, `value ${v}`);
  }
});

test('resolveFold: 放得下(total<=previewMax)→ 全保留、无隐藏', () => {
  assert.deepEqual(m.resolveFold(5, 10, ON), { keep: 5, hidden: 0 });
  assert.deepEqual(m.resolveFold(10, 10, ON), { keep: 10, hidden: 0 });
  assert.deepEqual(m.resolveFold(0, 10, ON), { keep: 0, hidden: 0 });
});

test('resolveFold: 门控开 恰藏 1 行 → 内联(keep=previewMax+1、hidden=0、不发标记)', () => {
  // 11 行、上限 10 → CC 内联第 11 行,不显 `+1 line`。
  assert.deepEqual(m.resolveFold(11, 10, ON), { keep: 11, hidden: 0 });
  assert.deepEqual(m.resolveFold(4, 3, ON), { keep: 4, hidden: 0 });
});

test('resolveFold: 隐藏 ≥2 行 → 标准折叠(keep=previewMax、hidden=total-previewMax)', () => {
  assert.deepEqual(m.resolveFold(12, 10, ON), { keep: 10, hidden: 2 });
  assert.deepEqual(m.resolveFold(30, 10, ON), { keep: 10, hidden: 20 });
});

test('resolveFold: 门控关 → 逐字节回退历史(恰藏 1 行仍标准折叠 hidden=1)', () => {
  assert.deepEqual(m.resolveFold(11, 10, INLINE_OFF), { keep: 10, hidden: 1 });
  // ≥2 行两态一致。
  assert.deepEqual(m.resolveFold(12, 10, INLINE_OFF), m.resolveFold(12, 10, ON));
  // 放得下两态一致。
  assert.deepEqual(m.resolveFold(5, 10, INLINE_OFF), m.resolveFold(5, 10, ON));
});

test('resolveFold: 门控开/关唯一分歧 = 恰藏 1 行', () => {
  // 唯一不同点。
  assert.notDeepEqual(m.resolveFold(11, 10, ON), m.resolveFold(11, 10, INLINE_OFF));
  // 其余全部逐字节一致(放得下 / ≥2 行隐藏)。
  for (const [t, p] of [[3, 10], [10, 10], [12, 10], [100, 10], [3, 1]]) {
    assert.deepEqual(m.resolveFold(t, p, ON), m.resolveFold(t, p, INLINE_OFF), `total=${t} max=${p}`);
  }
});

test('resolveFold: 防呆 非有限 → 0,绝不抛', () => {
  assert.deepEqual(m.resolveFold(NaN, 10, ON), { keep: 0, hidden: 0 });
  assert.deepEqual(m.resolveFold(11, NaN, ON), { keep: 0, hidden: 11 }); // previewMax→0,11>0 全隐藏
  assert.deepEqual(m.resolveFold(undefined, undefined, ON), { keep: 0, hidden: 0 });
  assert.doesNotThrow(() => m.resolveFold(undefined, undefined, ON));
});
