'use strict';

/**
 * messagePredicates 契约测试 — 纯叶子(CC isHumanTurn 计数判别 SSOT)。
 * 对齐 CC src/utils/messagePredicates.ts:tool_result 载体与真人共享 user 角色,
 * 只有真人回合才计入「用户消息」。零 IO。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  humanTurnCountEnabled,
  userMessageKind,
  isHumanTurn,
} = require('../../src/cli/messagePredicates');

// ── 门控 ─────────────────────────────────────────────────────────────────
test('humanTurnCountEnabled:默认开;{0,false,off,no} 关(大小写/空白无关)', () => {
  assert.strictEqual(humanTurnCountEnabled({}), true);
  assert.strictEqual(humanTurnCountEnabled({ KHY_HUMAN_TURN_COUNT: '1' }), true);
  assert.strictEqual(humanTurnCountEnabled({ KHY_HUMAN_TURN_COUNT: 'on' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(humanTurnCountEnabled({ KHY_HUMAN_TURN_COUNT: v }), false, v);
  }
});

// ── 真人回合 ─────────────────────────────────────────────────────────────
test('真人 user 回合(纯文本 / 结构化非 tool_result 块)→ human', () => {
  assert.strictEqual(userMessageKind({ role: 'user', content: '你好，帮我改个 bug' }), 'human');
  assert.strictEqual(isHumanTurn({ role: 'user', content: '你好' }), true);
  // 含图片的真人消息:content 是块数组但无 tool_result → 仍是 human。
  assert.strictEqual(
    userMessageKind({ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image' }] }),
    'human',
  );
  // role 'human' 同义。
  assert.strictEqual(isHumanTurn({ role: 'human', content: 'hey' }), true);
});

// ── 工具结果载体(非真人)──────────────────────────────────────────────────
test('工具结果载体(纯文本 [Tool Result] 前缀)→ tool,非 human', () => {
  const m = { role: 'user', content: '[Tool Result]\n{"ok":true}' };
  assert.strictEqual(userMessageKind(m), 'tool');
  assert.strictEqual(isHumanTurn(m), false);
});

test('工具结果载体(结构化 tool_result 块)→ tool,非 human', () => {
  const m = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] };
  assert.strictEqual(userMessageKind(m), 'tool');
  assert.strictEqual(isHumanTurn(m), false);
});

// ── 压缩摘要载体(meta)─────────────────────────────────────────────────────
test('压缩摘要载体([ContextCompact 前缀)→ meta,非 human', () => {
  const m = { role: 'user', content: '[ContextCompact v2 @ 2026-07-01T00:00:00Z]\nMode: …' };
  assert.strictEqual(userMessageKind(m), 'meta');
  assert.strictEqual(isHumanTurn(m), false);
});

test('显式 isMeta===true → meta(CC 前瞻兼容)', () => {
  assert.strictEqual(userMessageKind({ role: 'user', content: '任意', isMeta: true }), 'meta');
  assert.strictEqual(isHumanTurn({ role: 'user', content: '任意', isMeta: true }), false);
});

// ── 非 user 角色 / 畸形输入 ────────────────────────────────────────────────
test('非 user/human 角色 → null;畸形输入绝不抛', () => {
  assert.strictEqual(userMessageKind({ role: 'assistant', content: 'x' }), null);
  assert.strictEqual(userMessageKind({ role: 'tool', content: 'x' }), null);
  assert.strictEqual(userMessageKind(null), null);
  assert.strictEqual(userMessageKind(undefined), null);
  assert.strictEqual(userMessageKind('not-an-object'), null);
  assert.doesNotThrow(() => userMessageKind({ role: 'user' })); // content 缺失
  assert.strictEqual(userMessageKind({ role: 'user' }), 'human'); // 无 content → 默认 human
  assert.strictEqual(isHumanTurn({ role: 'assistant', content: 'x' }), false);
});

// ── 计数场景端到端(反映 getConversationStats 的分桶) ──────────────────────
test('混合会话:只有真人回合计入 userMessages', () => {
  const msgs = [
    { role: 'user', content: '第 1 个真实提问' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '[Tool Result]\n结果A' },
    { role: 'user', content: [{ type: 'tool_result', content: 'B' }] },
    { role: 'user', content: '第 2 个真实提问' },
    { role: 'user', content: '[ContextCompact v2 @ t]\n摘要' },
  ];
  const humans = msgs.filter(isHumanTurn).length;
  assert.strictEqual(humans, 2); // 只有 2 条真人,而非把 5 条 user 全算
});
