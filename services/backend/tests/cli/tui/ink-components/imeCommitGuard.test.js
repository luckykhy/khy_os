'use strict';

// imeCommitGuard 契约测试 — 纯叶子(IME 组字上屏 Enter 近因守卫)。CJK 输入法确认
// 组字时终端原子送出「组字文本(+可能的 Enter)」,ink 拆成两事件后裸 Enter 被误读为
// 用户提交;叶子按「全宽插入后的 120ms 守卫窗」吞掉它。零 IO 零网络。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../../src/cli/tui/imeCommitGuard');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_IME_ENTER_GUARD: off }), false, `应关: ${off}`);
  }
  // 大小写与空白不敏感;任意其他值保持开。
  assert.strictEqual(leaf.isEnabled({ KHY_IME_ENTER_GUARD: 'ON' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_IME_ENTER_GUARD: '1' }), true);
});

test('isImeCommitChunk:全宽才命中(单字 CJK/整词/emoji;ASCII/混合/带换行不命中)', () => {
  // 单字 CJK(逐键上屏)
  assert.strictEqual(leaf.isImeCommitChunk('你'), true);
  // 整词 chunk(nihao→你好)
  assert.strictEqual(leaf.isImeCommitChunk('你好'), true);
  // 全宽标点
  assert.strictEqual(leaf.isImeCommitChunk('！'), true);
  // emoji(textMeasure.isFullwidth 覆盖 0x1f300-0x1f9ff)
  assert.strictEqual(leaf.isImeCommitChunk('😀'), true);
  // ASCII 打字/混合/带换行的真实粘贴 → 不命中(守卫不吞)
  assert.strictEqual(leaf.isImeCommitChunk('a'), false);
  assert.strictEqual(leaf.isImeCommitChunk('a你'), false);
  assert.strictEqual(leaf.isImeCommitChunk('你\n好'), false);
  // 边界:空串/非字符串
  assert.strictEqual(leaf.isImeCommitChunk(''), false);
  assert.strictEqual(leaf.isImeCommitChunk(null), false);
  assert.strictEqual(leaf.isImeCommitChunk(undefined), false);
});

test('noteImeCommit→shouldSwallowBareEnter:窗内吞、窗外不吞、非组字不吞', () => {
  leaf._resetForTest();
  const t0 = 1_000_000;
  // 基线:无标记 → 不吞
  assert.strictEqual(leaf.shouldSwallowBareEnter(t0), false);
  // 组字上屏 → 窗内(119ms)吞
  leaf.noteImeCommit('你', t0);
  assert.strictEqual(leaf.shouldSwallowBareEnter(t0 + 119), true);
  // 恰好窗外(120ms)不吞
  assert.strictEqual(leaf.shouldSwallowBareEnter(t0 + leaf.IME_COMMIT_ENTER_GUARD_MS), false);
  // 非组字插入(ASCII)不打标记 → 不吞
  leaf._resetForTest();
  leaf.noteImeCommit('a', t0);
  assert.strictEqual(leaf.shouldSwallowBareEnter(t0 + 50), false);
  // 混合 chunk 不打标记
  leaf._resetForTest();
  leaf.noteImeCommit('a你', t0);
  assert.strictEqual(leaf.shouldSwallowBareEnter(t0 + 50), false);
  leaf._resetForTest();
});

test('门控关(KHY_IME_ENTER_GUARD=0):即使窗内有组字标记也不吞(逐字节回退)', () => {
  leaf._resetForTest();
  const t0 = 2_000_000;
  leaf.noteImeCommit('你好', t0);
  // 门控参数以 env 对象传入(叶子签名 shouldSwallowBareEnter(now, env))
  assert.strictEqual(leaf.shouldSwallowBareEnter(t0 + 10, { KHY_IME_ENTER_GUARD: '0' }), false);
  // noteImeCommit 的打点本身不受门控影响(门只在咨询侧)——但关态下永远 false
  leaf._resetForTest();
});

test('守卫窗常量:120ms(对齐 PASTE_NEWLINE_GUARD_MS 的近因窗量级)', () => {
  assert.strictEqual(leaf.IME_COMMIT_ENTER_GUARD_MS, 120);
});
