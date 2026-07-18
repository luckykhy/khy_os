'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderDedupEnabled, finalAlreadyStreamed } = require('./renderDedup');

const ON = {}; // 默认开(无 KHY_RENDER_DEDUP)
const OFF = { KHY_RENDER_DEDUP: '0' };

// 截图复现句:前轮已流式打印,末轮非流式重述同一句 → 必须判为重复。
const LINE = '已用 start 命令打开华为应用市场官网(https://appgallery.huawei.com/),默认浏览器应该已经跳转。';

// ── 门控梯 ──────────────────────────────────────────────────────────────────────
test('门控:默认开', () => {
  assert.equal(renderDedupEnabled(ON), true);
  assert.equal(renderDedupEnabled({}), true);
});

test('门控:0/false/off/no(含大小写)→ 关', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No', 'FALSE']) {
    assert.equal(renderDedupEnabled({ KHY_RENDER_DEDUP: v }), false);
  }
});

test('门控:其他值 → 开', () => {
  assert.equal(renderDedupEnabled({ KHY_RENDER_DEDUP: '1' }), true);
  assert.equal(renderDedupEnabled({ KHY_RENDER_DEDUP: 'yes' }), true);
});

// ── finalAlreadyStreamed ────────────────────────────────────────────────────────
test('命中:末轮文本=已流式内容(完全相同)→ 重复', () => {
  assert.equal(finalAlreadyStreamed(LINE, LINE, ON), true);
});

test('命中:末轮文本是已流式内容的尾部(前面还有别的流式片段)→ 重复', () => {
  const streamed = '让我打开华为应用市场。\n\n' + LINE;
  assert.equal(finalAlreadyStreamed(LINE, streamed, ON), true);
});

test('命中:仅空白/换行差异(分片 vs 最终串)→ 折叠后仍判重复', () => {
  const streamed = '已用 start 命令打开华为应用市场官网\n(https://appgallery.huawei.com/),\n默认浏览器应该已经跳转。';
  assert.equal(finalAlreadyStreamed(LINE, streamed, ON), true);
});

test('不误伤:末轮是新内容(与已流式不同)→ 正常渲染', () => {
  const streamed = '让我先看看你装了哪些应用。';
  assert.equal(finalAlreadyStreamed(LINE, streamed, ON), false);
});

test('不误伤:末轮文本是已流式内容的「开头」而非尾部 → false', () => {
  // finalText 在 streamed 中间出现但不在结尾(后面还有新结论)→ 不应抑制。
  const streamed = LINE + '\n另外建议你顺手清理一下桌面。';
  assert.equal(finalAlreadyStreamed(LINE, streamed, ON), false);
});

test('不误伤:本回合从未流式(streamedText 空)→ false(避免静默)', () => {
  assert.equal(finalAlreadyStreamed(LINE, '', ON), false);
  assert.equal(finalAlreadyStreamed(LINE, '   \n  ', ON), false);
});

test('finalText 空 → false', () => {
  assert.equal(finalAlreadyStreamed('', LINE, ON), false);
  assert.equal(finalAlreadyStreamed('   ', LINE, ON), false);
});

test('门控关 → 恒 false(逐字节回退,即便完全相同)', () => {
  assert.equal(finalAlreadyStreamed(LINE, LINE, OFF), false);
});

test('防呆:null/undefined/非串绝不抛', () => {
  assert.equal(finalAlreadyStreamed(null, null, ON), false);
  assert.equal(finalAlreadyStreamed(undefined, undefined, ON), false);
  assert.equal(finalAlreadyStreamed(12345, 12345, ON), true); // 数字 12345 折叠后相等 → 尾部命中(确定性,不抛)
  assert.equal(finalAlreadyStreamed({}, [], ON), false);
});
