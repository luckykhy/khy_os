'use strict';

// interruptionMarker 叶子契约测试(node:test)。
// 核心:ESC/中断时把「部分回复 + 中断标记 / 仅标记」落进 assistant content,
// 门控关 → null → 调用方 no-op 逐字节回退(不记录标记)。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  interruptionMarkerEnabled,
  buildInterruptedAssistantContent,
  INTERRUPTION_NOTE,
} = require('../../src/services/interruptionMarker');

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(interruptionMarkerEnabled({}), true);
  assert.strictEqual(interruptionMarkerEnabled({ KHY_INTERRUPT_MARKER: '' }), true);
  assert.strictEqual(interruptionMarkerEnabled({ KHY_INTERRUPT_MARKER: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      interruptionMarkerEnabled({ KHY_INTERRUPT_MARKER: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('门控开:有部分回复 → 部分回复 + 换行 + 标记', () => {
  const on = { KHY_INTERRUPT_MARKER: '1' };
  assert.strictEqual(
    buildInterruptedAssistantContent('我正在分析这段代码', on),
    `我正在分析这段代码\n\n${INTERRUPTION_NOTE}`,
  );
});

test('门控开:无部分回复(空/空白/null/undefined)→ 仅标记', () => {
  const on = { KHY_INTERRUPT_MARKER: '1' };
  assert.strictEqual(buildInterruptedAssistantContent('', on), INTERRUPTION_NOTE);
  assert.strictEqual(buildInterruptedAssistantContent('   \n  ', on), INTERRUPTION_NOTE);
  assert.strictEqual(buildInterruptedAssistantContent(null, on), INTERRUPTION_NOTE);
  assert.strictEqual(buildInterruptedAssistantContent(undefined, on), INTERRUPTION_NOTE);
});

test('门控开:部分回复首尾空白被 trim', () => {
  const on = { KHY_INTERRUPT_MARKER: '1' };
  assert.strictEqual(
    buildInterruptedAssistantContent('  部分内容  ', on),
    `部分内容\n\n${INTERRUPTION_NOTE}`,
  );
});

test('门控开:非字符串部分回复被稳健转字符串', () => {
  const on = { KHY_INTERRUPT_MARKER: '1' };
  assert.strictEqual(buildInterruptedAssistantContent(123, on), `123\n\n${INTERRUPTION_NOTE}`);
});

test('门控关 → null(调用方 no-op,逐字节回退今日行为)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      buildInterruptedAssistantContent('部分回复', { KHY_INTERRUPT_MARKER: off }),
      null,
      `门控关(${off})应返回 null`,
    );
    assert.strictEqual(
      buildInterruptedAssistantContent('', { KHY_INTERRUPT_MARKER: off }),
      null,
    );
  }
});

test('标记文案语义对齐 CC 的 [Request interrupted by user]', () => {
  assert.strictEqual(INTERRUPTION_NOTE, '[用户已中断本次回复]');
});
