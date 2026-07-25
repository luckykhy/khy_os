'use strict';

// 纯叶子 ccTruncateLines 的单测:对齐 CC `src/utils/stringUtils.ts` `truncateToLines`
// 的后端逻辑——行数截断绝不静默,始终缀诚实标记。
//  - truncateToLines:CC 逐字节移植(≤maxLines 原样;>maxLines 前 N 行 + '…');
//  - truncatePreview:门控诚实预览(关 → 逐字节回退历史静默 slice.join;开 → 头 + 「… +N 行」);
//  - 防呆:非字符串 / maxLines 非有限 / 负数 → 安全返回,绝不抛。
const test = require('node:test');
const assert = require('node:assert');
const {
  truncateLinesEnabled,
  truncateToLines,
  truncatePreview,
} = require('../../src/cli/ccTruncateLines');

test('truncateLinesEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(truncateLinesEnabled({}), true);
  assert.strictEqual(truncateLinesEnabled({ KHY_TRUNCATE_TO_LINES: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(truncateLinesEnabled({ KHY_TRUNCATE_TO_LINES: off }), false, `应关: ${off}`);
  }
});

test('truncateToLines:CC 逐字节——≤maxLines 原样返回(split/join 恒等)', () => {
  assert.strictEqual(truncateToLines('a\nb\nc', 3), 'a\nb\nc');
  assert.strictEqual(truncateToLines('a\nb\nc', 5), 'a\nb\nc');
  assert.strictEqual(truncateToLines('solo', 1), 'solo');
  assert.strictEqual(truncateToLines('', 3), '');
});

test('truncateToLines:CC 逐字节——>maxLines 前 N 行 join + 裸 "…"(缀末行尾)', () => {
  assert.strictEqual(truncateToLines('a\nb\nc\nd', 2), 'a\nb…');
  assert.strictEqual(truncateToLines('1\n2\n3\n4\n5', 3), '1\n2\n3…');
  // 自定义标记
  assert.strictEqual(truncateToLines('a\nb\nc', 1, ' [more]'), 'a [more]');
});

test('truncateToLines:防呆——maxLines 非有限 / 负 → 原文,非字符串先转串', () => {
  assert.strictEqual(truncateToLines('a\nb\nc', NaN), 'a\nb\nc');
  assert.strictEqual(truncateToLines('a\nb\nc', -1), 'a\nb\nc');
  assert.strictEqual(truncateToLines(null, 2), '');
  assert.strictEqual(truncateToLines(12345, 1), '12345');
});

test('truncatePreview:行数 ≤ maxLines → 两态都原样(无标记)', () => {
  for (const env of [{}, { KHY_TRUNCATE_TO_LINES: 'off' }]) {
    assert.strictEqual(truncatePreview('a\nb\nc', 3, env), 'a\nb\nc');
    assert.strictEqual(truncatePreview('a\nb', 10, env), 'a\nb');
  }
});

test('truncatePreview:门控关 → 逐字节回退历史静默 slice.join(无标记)', () => {
  const text = '1\n2\n3\n4\n5';
  const env = { KHY_TRUNCATE_TO_LINES: 'off' };
  assert.strictEqual(truncatePreview(text, 3, env), '1\n2\n3');
  // 与历史写法逐字节等价
  assert.strictEqual(
    truncatePreview(text, 3, env),
    text.split('\n').slice(0, 3).join('\n')
  );
});

test('truncatePreview:门控开 → 头 + 独立「… +N 行」诚实标记(告知丢了多少行)', () => {
  const text = '1\n2\n3\n4\n5\n6';
  assert.strictEqual(truncatePreview(text, 4, {}), '1\n2\n3\n4\n… +2 行');
  // 截掉一大段:200 行文档切到 80
  const big = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n');
  const out = truncatePreview(big, 80, {});
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 81);              // 80 内容 + 1 标记
  assert.strictEqual(lines[79], 'L80');
  assert.strictEqual(lines[80], '… +120 行');
});

test('truncatePreview:门控开 + 行数恰好阈值边界 → 不截断不加标记', () => {
  assert.strictEqual(truncatePreview('a\nb\nc', 3, {}), 'a\nb\nc');   // 恰好 3 行
  assert.strictEqual(truncatePreview('a\nb\nc\nd', 3, {}), 'a\nb\nc\n… +1 行'); // 4 行 → 截
});

test('truncatePreview:防呆——maxLines 非有限 / 负 → 原文', () => {
  assert.strictEqual(truncatePreview('a\nb\nc', NaN, {}), 'a\nb\nc');
  assert.strictEqual(truncatePreview('a\nb\nc', -2, {}), 'a\nb\nc');
});
