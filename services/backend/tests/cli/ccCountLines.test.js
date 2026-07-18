'use strict';

// ccCountLines 契约测试 — 纯叶子(CC countLines 行计数 SSOT)。
// 对齐 CC FileWriteTool/UI.tsx countLines:末尾换行当行终止符、永远按 '\n' 切。
// 零 IO。
const test = require('node:test');
const assert = require('node:assert');

const {
  countLinesEnabled,
  ccCountLines,
  countLinesOr,
} = require('../../src/cli/ccCountLines');

// ── 门控 ─────────────────────────────────────────────────────────────────
test('countLinesEnabled:默认开;{0,false,off,no} 关(大小写/空白无关)', () => {
  assert.strictEqual(countLinesEnabled({}), true);
  assert.strictEqual(countLinesEnabled({ KHY_WRITE_COUNT_LINES_CC: '1' }), true);
  assert.strictEqual(countLinesEnabled({ KHY_WRITE_COUNT_LINES_CC: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(countLinesEnabled({ KHY_WRITE_COUNT_LINES_CC: v }), false, v);
  }
});

// ── ccCountLines(CC 逐字节口径)────────────────────────────────────────────
test('ccCountLines:末尾换行当终止符,不多算 1 行', () => {
  // 3 行、以 '\n' 结尾(文件常态)→ 3(裸 split 会得 4)。
  assert.strictEqual(ccCountLines('a\nb\nc\n'), 3);
  assert.strictEqual('a\nb\nc\n'.split('\n').length, 4); // 佐证裸口径多算 1
  // 无尾随换行 → 行数 = 段数。
  assert.strictEqual(ccCountLines('a\nb\nc'), 3);
  // 单行、以 '\n' 结尾 → 1(裸 split 得 2)。
  assert.strictEqual(ccCountLines('hello\n'), 1);
  assert.strictEqual(ccCountLines('hello'), 1);
});

test('ccCountLines:多个尾随换行只减 1(仅最末换行是终止符)', () => {
  // 'a\n\n' → parts ['a','',''] len3;endsWith '\n' → 2(中间的空行仍是一行)。
  assert.strictEqual(ccCountLines('a\n\n'), 2);
});

test('ccCountLines:空串 → 1(CC 口径;call-site 自守卫成 0)', () => {
  assert.strictEqual(ccCountLines(''), 1);
});

test('ccCountLines:非串输入归一、绝不抛', () => {
  assert.strictEqual(ccCountLines(null), 1);       // → '' → 1
  assert.strictEqual(ccCountLines(undefined), 1);
  assert.doesNotThrow(() => ccCountLines(12345));  // '12345' → 1
  assert.strictEqual(ccCountLines(12345), 1);
});

// ── countLinesOr(门控包装,两 call-site 共用)──────────────────────────────
test('countLinesOr:门控开 → CC countLines(修 off-by-one)', () => {
  assert.strictEqual(countLinesOr('a\nb\nc\n', { KHY_WRITE_COUNT_LINES_CC: '1' }), 3);
  assert.strictEqual(countLinesOr('hello\n', { KHY_WRITE_COUNT_LINES_CC: '1' }), 1);
});

test('countLinesOr:门控关 → 裸 split(逐字节回退历史 legacy)', () => {
  assert.strictEqual(countLinesOr('a\nb\nc\n', { KHY_WRITE_COUNT_LINES_CC: 'off' }), 4);
  assert.strictEqual(countLinesOr('hello\n', { KHY_WRITE_COUNT_LINES_CC: '0' }), 2);
  assert.strictEqual(countLinesOr('hello', { KHY_WRITE_COUNT_LINES_CC: 'off' }), 1);
});

test('countLinesOr:门控开/关对无尾随换行内容一致(只在尾随换行时发散)', () => {
  const noTrail = 'x\ny\nz';
  assert.strictEqual(countLinesOr(noTrail, { KHY_WRITE_COUNT_LINES_CC: '1' }), 3);
  assert.strictEqual(countLinesOr(noTrail, { KHY_WRITE_COUNT_LINES_CC: 'off' }), 3);
});

test('countLinesOr:非串/空输入不抛', () => {
  assert.doesNotThrow(() => countLinesOr(null, {}));
  assert.doesNotThrow(() => countLinesOr(undefined, { KHY_WRITE_COUNT_LINES_CC: '1' }));
});
