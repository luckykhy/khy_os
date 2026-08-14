'use strict';

// statsConversationLines 叶子契约测试(node:test)。
// 核心:交互 /stats 追加「消息: 共 N 条（用户 a · 助手 b · 工具 c）」构成行,
// 门控关 / total<=0 / 坏输入 → [] 逐字节回退(两交互孪生不追加任何行)。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  statsConversationEnabled,
  buildConversationCompositionLines,
} = require('../../src/cli/statsConversationLines');

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(statsConversationEnabled({}), true);
  assert.strictEqual(statsConversationEnabled({ KHY_STATS_CONVERSATION: '' }), true);
  assert.strictEqual(statsConversationEnabled({ KHY_STATS_CONVERSATION: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      statsConversationEnabled({ KHY_STATS_CONVERSATION: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('门控开:全字段齐 → 单条对话构成行(用户/助手/工具)', () => {
  const on = { KHY_STATS_CONVERSATION: '1' };
  const lines = buildConversationCompositionLines(
    { totalMessages: 42, userMessages: 5, assistantMessages: 20, toolMessages: 15 },
    on,
  );
  assert.deepStrictEqual(lines, ['消息: 共 42 条（用户 5 · 助手 20 · 工具 15）']);
});

test('门控开:total 含未列出的 system/other 时,总数用 totalMessages 原值(不臆造三类之和)', () => {
  const on = { KHY_STATS_CONVERSATION: '1' };
  // total 50,但只列 user/assistant/tool(system+other=10 不并入分项也不减总数)
  const lines = buildConversationCompositionLines(
    { totalMessages: 50, userMessages: 5, assistantMessages: 20, toolMessages: 15, systemMessages: 8, otherMessages: 2 },
    on,
  );
  assert.deepStrictEqual(lines, ['消息: 共 50 条（用户 5 · 助手 20 · 工具 15）']);
});

test('门控开:分项缺失 → 各按 0 呈现(总数>0 仍出行)', () => {
  const on = { KHY_STATS_CONVERSATION: '1' };
  assert.deepStrictEqual(
    buildConversationCompositionLines({ totalMessages: 3 }, on),
    ['消息: 共 3 条（用户 0 · 助手 0 · 工具 0）'],
  );
});

test('门控开:totalMessages<=0 / 畸形 → [](无对话不出行)', () => {
  const on = { KHY_STATS_CONVERSATION: '1' };
  assert.deepStrictEqual(buildConversationCompositionLines({ totalMessages: 0 }, on), []);
  assert.deepStrictEqual(buildConversationCompositionLines({ totalMessages: -5, userMessages: 3 }, on), []);
  assert.deepStrictEqual(buildConversationCompositionLines({ totalMessages: 'NaN' }, on), []);
});

test('门控开:分项畸形(负/非数/小数)稳健处理', () => {
  const on = { KHY_STATS_CONVERSATION: '1' };
  const lines = buildConversationCompositionLines(
    { totalMessages: 9.7, userMessages: -2, assistantMessages: 'x', toolMessages: 4.9 },
    on,
  );
  assert.deepStrictEqual(lines, ['消息: 共 9 条（用户 0 · 助手 0 · 工具 4）']);
});

test('门控关 → [] 逐字节回退(两交互孪生不追加构成行)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      buildConversationCompositionLines(
        { totalMessages: 42, userMessages: 5, assistantMessages: 20, toolMessages: 15 },
        { KHY_STATS_CONVERSATION: off },
      ),
      [],
      `门控关(${off})应返回 []`,
    );
  }
});

test('缺 stats / null / 非对象 不抛(返回 [])', () => {
  const on = { KHY_STATS_CONVERSATION: '1' };
  assert.deepStrictEqual(buildConversationCompositionLines(undefined, on), []);
  assert.deepStrictEqual(buildConversationCompositionLines(null, on), []);
  assert.deepStrictEqual(buildConversationCompositionLines({}, on), []);
  assert.deepStrictEqual(buildConversationCompositionLines(123, on), []);
});
