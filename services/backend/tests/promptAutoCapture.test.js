'use strict';

/**
 * promptAutoCapture — 纯叶子单测(node:test)。
 *
 * 覆盖:门控默认开/显式关、长度边界、指令性结构命中、闲聊排除、坏输入不抛、
 * deriveTitle 派生。全合成输入,零 IO。
 */

const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../src/services/promptAutoCapture');

const ON = {}; // 无门控键 → 默认开
const OFF = { KHY_PROMPT_AUTOCAPTURE: '0' };

// 一条像样的、含角色设定 + 分步 + 格式约束的可复用提示词(足够长)。
const GOOD = '你是一名资深后端工程师。请分步分析下面的代码，第一步指出潜在的并发问题，'
  + '第二步给出修复方案，并以 markdown 表格输出结论。';

test('autoCaptureEnabled: 默认开;显式 0/false/off/no 关', () => {
  assert.strictEqual(leaf.autoCaptureEnabled({}), true);
  assert.strictEqual(leaf.autoCaptureEnabled({ KHY_PROMPT_AUTOCAPTURE: '' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
    assert.strictEqual(leaf.autoCaptureEnabled({ KHY_PROMPT_AUTOCAPTURE: v }), false, `should disable on ${v}`);
  }
  assert.strictEqual(leaf.autoCaptureEnabled({ KHY_PROMPT_AUTOCAPTURE: '1' }), true);
});

test('shouldCapture: 命中指令性结构的长提示词 → true', () => {
  assert.strictEqual(leaf.shouldCapture(GOOD, ON), true);
});

test('shouldCapture: 门控关 → 恒 false(逐字节回退今日无捕获)', () => {
  assert.strictEqual(leaf.shouldCapture(GOOD, OFF), false);
});

test('shouldCapture: 太短(< MIN_LEN)→ false', () => {
  assert.strictEqual(leaf.shouldCapture('你是助手', ON), false);
  assert.ok(GOOD.length >= leaf.MIN_LEN);
});

test('shouldCapture: 太长(> MAX_LEN)→ false', () => {
  const huge = '请' + 'x'.repeat(leaf.MAX_LEN + 10);
  assert.strictEqual(leaf.shouldCapture(huge, ON), false);
});

test('shouldCapture: 长但无指令性结构(普通陈述)→ false', () => {
  const plain = '今天天气不错，我随便说了一大段话但其实没有任何结构化的内容，'
    + '只是闲聊一下最近发生的事情而已，跟一条可以复用的模板完全不沾边。';
  assert.strictEqual(leaf.shouldCapture(plain, ON), false);
});

test('shouldCapture: 一次性闲聊短语(排除信号)→ false', () => {
  assert.strictEqual(leaf.shouldCapture('你好', ON), false);
  assert.strictEqual(leaf.shouldCapture('thanks', ON), false);
});

test('shouldCapture: 英文 act-as 角色设定 + step-by-step → true', () => {
  const en = 'You are a senior security engineer. Please review this code step by step '
    + 'and always output your findings as a markdown table with severity levels.';
  assert.strictEqual(leaf.shouldCapture(en, ON), true);
});

test('shouldCapture: 坏输入(null/非字符串/对象)绝不抛 → false', () => {
  assert.strictEqual(leaf.shouldCapture(null, ON), false);
  assert.strictEqual(leaf.shouldCapture(undefined, ON), false);
  assert.strictEqual(leaf.shouldCapture(12345, ON), false);
  assert.strictEqual(leaf.shouldCapture({}, ON), false);
  assert.strictEqual(leaf.shouldCapture([], ON), false);
});

test('deriveTitle: 取首行截断;坏输入回退默认', () => {
  assert.strictEqual(leaf.deriveTitle('第一行标题\n第二行正文'), '第一行标题');
  assert.strictEqual(leaf.deriveTitle(''), 'AI 发现的提示词');
  assert.strictEqual(leaf.deriveTitle(null), 'AI 发现的提示词');
  const long = 'x'.repeat(60);
  const t = leaf.deriveTitle(long);
  assert.ok(t.length <= 41 && t.endsWith('…'), 'long first line ellipsized');
});
