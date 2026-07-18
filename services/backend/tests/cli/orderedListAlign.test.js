'use strict';

// orderedListAlign 纯叶子:有序列表标记右对齐(对齐 CC ui/OrderedList.tsx padStart)。
// 验证 9→10 对齐、同宽 run 字节不变、保留源序号、缩进/非项行断 run、绝不抛、门控。
const test = require('node:test');
const assert = require('node:assert');
const {
  alignOrderedListMarkers,
  orderedListAlignEnabled,
} = require('../../src/cli/orderedListAlign');

test('跨 9→10:个位项补一个前导空格,点号对齐', () => {
  const input = ['1. one', '2. two', '9. nine', '10. ten'].join('\n');
  const out = alignOrderedListMarkers(input).split('\n');
  assert.deepStrictEqual(out, [' 1. one', ' 2. two', ' 9. nine', '10. ten']);
  // 每行 marker(到点号)同宽 = 3。
  for (const line of out) {
    const marker = line.slice(0, line.indexOf('.') + 1);
    assert.strictEqual(marker.length, 3, `marker 应宽 3: ${JSON.stringify(marker)}`);
  }
});

test('同宽 run(全个位)→ 逐字节不变', () => {
  const input = ['1. a', '2. b', '3. c'].join('\n');
  assert.strictEqual(alignOrderedListMarkers(input), input);
});

test('单项 run → 不变(无可对齐对象)', () => {
  assert.strictEqual(alignOrderedListMarkers('1. only'), '1. only');
  assert.strictEqual(alignOrderedListMarkers('7. seven'), '7. seven');
});

test('保留源序号(从 5 开始,不重编号)', () => {
  const input = ['5. e', '6. f', '10. j'].join('\n');
  const out = alignOrderedListMarkers(input).split('\n');
  assert.deepStrictEqual(out, [' 5. e', ' 6. f', '10. j']);
});

test('不同缩进 = 嵌套 → 各 run 独立对齐', () => {
  const input = [
    '1. top',
    '  9. child',     // 2-space indent run A: 单项 → 不变
    '  10. child2',   // 仍 2-space?不同——见下:这两行同缩进吗?
  ].join('\n');
  // 上面的 child / child2 缩进相同(2 空格)→ 同 run,9→10 对齐。
  const out = alignOrderedListMarkers(input).split('\n');
  assert.strictEqual(out[0], '1. top');          // 顶层单项,不变
  assert.strictEqual(out[1], '   9. child');     // 2 缩进 + 1 pad
  assert.strictEqual(out[2], '  10. child2');    // 2 缩进 + 0 pad
});

test('非项行断开 run', () => {
  const input = [
    '9. nine',
    'plain paragraph',
    '10. ten',
  ].join('\n');
  const out = alignOrderedListMarkers(input).split('\n');
  // 两个单项 run,各自不补 pad。
  assert.deepStrictEqual(out, ['9. nine', 'plain paragraph', '10. ten']);
});

test('正文与间隔空白逐字保留', () => {
  const input = ['9.   spaced  content', '10. x'].join('\n');
  const out = alignOrderedListMarkers(input).split('\n');
  assert.strictEqual(out[0], ' 9.   spaced  content');
  assert.strictEqual(out[1], '10. x');
});

test('三位数 run:百位对齐', () => {
  const input = ['8. a', '99. b', '100. c'].join('\n');
  const out = alignOrderedListMarkers(input).split('\n');
  assert.deepStrictEqual(out, ['  8. a', ' 99. b', '100. c']);
});

test('无点号 → 快路径原样返回', () => {
  const input = 'just text\nno markers here';
  assert.strictEqual(alignOrderedListMarkers(input), input);
});

test('绝不抛:null/非字符串', () => {
  assert.doesNotThrow(() => alignOrderedListMarkers(null));
  assert.strictEqual(alignOrderedListMarkers(null), '');
  assert.strictEqual(alignOrderedListMarkers(undefined), '');
  assert.strictEqual(alignOrderedListMarkers(123), '123');
});

test('门控默认开 + 关 token + 其他开', () => {
  assert.strictEqual(orderedListAlignEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(orderedListAlignEnabled({ KHY_OL_MARKER_ALIGN: v }), false);
  }
  assert.strictEqual(orderedListAlignEnabled({ KHY_OL_MARKER_ALIGN: '1' }), true);
});
