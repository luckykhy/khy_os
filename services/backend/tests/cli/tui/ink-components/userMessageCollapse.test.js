'use strict';

// userMessageCollapse 契约测试 — 纯叶子(超长用户消息头尾折叠)。对齐 CC
// UserPromptMessage.tsx 的 10000/2500/2500 阈值 + countCharInString 隐藏行计数。
// 零 IO 零网络。
const test = require('node:test');
const assert = require('node:assert');

const leaf = require('../../../../src/cli/tui/ink-components/userMessageCollapse');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(leaf.isEnabled({ KHY_USER_MSG_COLLAPSE: off }), false, `应关: ${off}`);
  }
});

test('常量对齐 CC(10000/2500/2500)', () => {
  assert.strictEqual(leaf.MAX_DISPLAY_CHARS, 10000);
  assert.strictEqual(leaf.TRUNCATE_HEAD_CHARS, 2500);
  assert.strictEqual(leaf.TRUNCATE_TAIL_CHARS, 2500);
});

test('countCharInString:从 start 起计单字符出现次数(对齐 CC)', () => {
  assert.strictEqual(leaf.countCharInString('a\nb\nc', '\n', 0), 2);
  assert.strictEqual(leaf.countCharInString('a\nb\nc', '\n', 2), 1); // 从 index 2 起只剩第二个 \n
  assert.strictEqual(leaf.countCharInString('abc', '\n', 0), 0);
  assert.strictEqual(leaf.countCharInString('', '\n', 0), 0);
  assert.strictEqual(leaf.countCharInString(null, '\n', 0), 0);
});

test('collapse:<=10000 字符原样透传(不折叠)', () => {
  const short = 'x'.repeat(10000);
  assert.strictEqual(leaf.collapseLongUserMessage(short, {}), short);
  const tiny = 'hello\nworld';
  assert.strictEqual(leaf.collapseLongUserMessage(tiny, {}), tiny);
});

test('collapse:>10000 → head2500 + 「… +N lines …」+ tail2500,N=中段换行数', () => {
  // 构造:2500 头(无换行) + 中段 500 换行 + 填充 + 2500 尾(无换行)。总长须 > 10000
  // 才触发折叠(2500 + 5500 + 2500 = 10500)。
  const head = 'H'.repeat(2500);
  const middle = '\n'.repeat(500) + 'M'.repeat(5000);
  const tail = 'T'.repeat(2500);
  const text = head + middle + tail;
  assert.ok(text.length > 10000, '构造应超阈值');
  const out = leaf.collapseLongUserMessage(text, {});
  // 头 2500 = 全 H
  assert.strictEqual(out.slice(0, 2500), head);
  // 尾 2500 = 全 T
  assert.strictEqual(out.slice(-2500), tail);
  // 标记行:中段换行 500 个都在 [2500, len-2500) 内,tail 无换行 → N=500
  assert.match(out, /\n… \+500 lines …\n/);
});

test('collapse:尾部含换行时正确扣减(hiddenLines 只算中段)', () => {
  // 头 2500 无换行;中段 3 换行 + 大填充(保总长 > 10000);尾 2500 含 2 换行。
  // countCharInString(text,'\n',2500) = 中段3 + 尾2 = 5;countCharInString(tail,'\n')=2 → N=3。
  const head = 'H'.repeat(2500);
  const middle = 'a\nb\nc\n' + 'M'.repeat(6000);
  const tail = 'x\ny\n' + 'T'.repeat(2496); // 长度 2500,含 2 换行
  assert.strictEqual(tail.length, 2500);
  const text = head + middle + tail;
  const out = leaf.collapseLongUserMessage(text, {});
  assert.match(out, /\n… \+3 lines …\n/);
});

test('collapse:门控关 → 原样透传(字节回退),即便超长', () => {
  const text = 'z'.repeat(20000);
  assert.strictEqual(leaf.collapseLongUserMessage(text, { KHY_USER_MSG_COLLAPSE: '0' }), text);
});

test('collapse:防呆——非串/空串/异常 → 返回原值,绝不抛', () => {
  assert.strictEqual(leaf.collapseLongUserMessage('', {}), '');
  assert.strictEqual(leaf.collapseLongUserMessage(null, {}), null);
  assert.strictEqual(leaf.collapseLongUserMessage(undefined, {}), undefined);
  assert.doesNotThrow(() => leaf.collapseLongUserMessage(12345, {}));
  assert.strictEqual(leaf.collapseLongUserMessage(12345, {}), 12345);
});
