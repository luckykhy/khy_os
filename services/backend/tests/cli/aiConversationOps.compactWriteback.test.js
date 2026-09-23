'use strict';

/**
 * [DESIGN-ARCH-135] 一期回归 —— 压缩视图回写（reconcileTurnHistory 可选第四参）。
 *
 * 钉住两条语义：
 *   1) 不传第四参时，行为与改动前**逐字节相同**（可选参数 = 回滚能力，
 *      撤掉调用方那一处传参即可回到旧行为）；
 *   2) 传了 `compactedMessages` 时，压缩视图成为新的模型上下文真源，
 *      且本回合的最终回复在尾部**恰好出现一次**（不重复、不缺失）。
 *
 * 为什么用 node:test 而不是 jest 全局：服务端 package.json 的 `test:node` 是
 * `node --test tests/ 下的 *.test.js`（`.github/workflows/pr-gate.yml` 会跑到），
 * 该 glob 会扫到本文件 —— 混用裸 describe/test 会在 `node --test` 下
 * `describe is not defined` 而**落地即红**。
 */

const test = require('node:test');
const assert = require('node:assert');

const chatState = require('../../src/cli/aiChatState');
const conv = require('../../src/cli/aiConversationOps');

// `_chatState` 是进程级单例，每个用例必须自带完整前置状态。
function seed(msgs) {
  chatState.messages = msgs.map((m) => ({ role: m.role, content: m.content }));
  return chatState.messages;
}
function contents() {
  return chatState.messages.map((m) => m.content);
}

// ── 1) 缺参：旧行为必须原样保留（回滚语义）────────────────────────────

test('#135-01 缺参 · 孤儿 user → 只补 assistant', () => {
  seed([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'ok' },
  ]);
  const snap = conv.snapshotHistoryTurn();
  chatState.messages.push({ role: 'user', content: 'do it' });

  const r = conv.reconcileTurnHistory(snap, 'do it', 'done');

  assert.strictEqual(r.reason, 'paired_orphan_user');
  assert.strictEqual(r.appended, 1);
  assert.deepStrictEqual(contents(), ['old', 'ok', 'do it', 'done']);
});

test('#135-02 缺参 · 本回合已提交 → 零改动', () => {
  seed([
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'ok' },
  ]);
  const snap = conv.snapshotHistoryTurn();
  chatState.messages.push({ role: 'user', content: 'do it' });
  chatState.messages.push({ role: 'assistant', content: 'done' });

  const r = conv.reconcileTurnHistory(snap, 'do it', 'done');

  assert.strictEqual(r.reason, 'already_committed');
  assert.strictEqual(r.appended, 0);
  assert.deepStrictEqual(contents(), ['old', 'ok', 'do it', 'done']);
});

test('#135-03 缺参 · 空最终回复 → 不写入', () => {
  seed([{ role: 'user', content: 'old' }]);
  const snap = conv.snapshotHistoryTurn();

  const r = conv.reconcileTurnHistory(snap, 'do it', '   ');

  assert.strictEqual(r.reason, 'empty_final_reply');
  assert.strictEqual(r.appended, 0);
  assert.deepStrictEqual(contents(), ['old']);
});

test('#135-04 缺参 · 完全无痕 → 补 user + assistant 一对', () => {
  seed([{ role: 'user', content: 'old' }]);
  const snap = conv.snapshotHistoryTurn();

  const r = conv.reconcileTurnHistory(snap, 'do it', 'done');

  assert.strictEqual(r.reason, 'committed_missing_turn');
  assert.strictEqual(r.appended, 2);
  assert.deepStrictEqual(contents(), ['old', 'do it', 'done']);
});

// ── 2) 传参：压缩视图必须成为真源（一期要修的就是这条）──────────────

test('#135-05 传 compactedMessages → 摘要进历史，并补上最终回复', () => {
  seed([
    { role: 'user', content: 'long-1' },
    { role: 'assistant', content: 'long-2' },
    { role: 'user', content: 'long-3' },
  ]);
  const snap = conv.snapshotHistoryTurn();

  const compacted = [
    { role: 'user', content: '<compressed_context>摘要</compressed_context>' },
    { role: 'assistant', content: '[tool round]' },
  ];
  const r = conv.reconcileTurnHistory(snap, 'do it', 'final answer', {
    compactedMessages: compacted,
  });

  assert.strictEqual(r.reason, 'compacted_writeback');
  assert.strictEqual(r.appended, 1);
  assert.deepStrictEqual(contents(), [
    '<compressed_context>摘要</compressed_context>',
    '[tool round]',
    'final answer',
  ]);
});

test('#135-06 压缩视图末尾已是最终回复 → 不重复 push', () => {
  seed([{ role: 'user', content: 'long-1' }]);
  const snap = conv.snapshotHistoryTurn();

  const compacted = [
    { role: 'user', content: '<compressed_context>摘要</compressed_context>' },
    { role: 'assistant', content: 'final answer' },
  ];
  const r = conv.reconcileTurnHistory(snap, 'do it', 'final answer', {
    compactedMessages: compacted,
  });

  assert.strictEqual(r.appended, 0);
  assert.deepStrictEqual(contents(), [
    '<compressed_context>摘要</compressed_context>',
    'final answer',
  ]);
});

test('#135-07 压缩视图是浅拷贝 —— 不污染调用方入参', () => {
  seed([{ role: 'user', content: 'long-1' }]);
  const snap = conv.snapshotHistoryTurn();

  const compacted = [{ role: 'user', content: 'summary' }];
  conv.reconcileTurnHistory(snap, 'do it', 'final answer', { compactedMessages: compacted });

  assert.strictEqual(compacted.length, 1, '入参数组不得被 push 修改');
  assert.notStrictEqual(chatState.messages[0], compacted[0], '真源元素必须是拷贝');
});

test('#135-08 空最终回复 + 压缩视图 → 视图仍生效但不补回复', () => {
  seed([{ role: 'user', content: 'long-1' }]);
  const snap = conv.snapshotHistoryTurn();

  const compacted = [{ role: 'user', content: 'summary' }];
  const r = conv.reconcileTurnHistory(snap, 'do it', '', { compactedMessages: compacted });

  assert.strictEqual(r.appended, 0);
  assert.deepStrictEqual(contents(), ['summary']);
});

// ── 3) fail-soft：非法入参一律退回旧逻辑 ─────────────────────────────

test('#135-09 非法 compactedMessages 全部退回旧路径', () => {
  for (const bad of [undefined, null, [], 'nope', 0, {}]) {
    seed([{ role: 'user', content: 'old' }]);
    const snap = conv.snapshotHistoryTurn();
    chatState.messages.push({ role: 'user', content: 'do it' });

    const r = conv.reconcileTurnHistory(snap, 'do it', 'done', { compactedMessages: bad });

    assert.notStrictEqual(r.reason, 'compacted_writeback', `bad=${String(bad)} 应退回旧逻辑`);
    assert.strictEqual(r.reason, 'paired_orphan_user');
    assert.deepStrictEqual(contents(), ['old', 'do it', 'done']);
  }
});

test('#135-10 缺 snapshot → no_snapshot（即使带了 compacted）', () => {
  seed([{ role: 'user', content: 'old' }]);

  const r = conv.reconcileTurnHistory(null, 'do it', 'done', {
    compactedMessages: [{ role: 'user', content: 'summary' }],
  });

  assert.strictEqual(r.reason, 'no_snapshot');
  assert.deepStrictEqual(contents(), ['old']);
});
