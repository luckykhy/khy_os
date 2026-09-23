#!/usr/bin/env node
'use strict';

/**
 * test-a2a-mcp-server-smoke.js — S3(A2A 服务端任务面) + S4(MCP 2025-03-26) 运行时冒烟测试。
 * 纯 node,无测试框架依赖;任一断言失败 → 进程退出码 1。
 */

const assert = require('assert');
const path = require('path');
const A2A_DIR = path.join(__dirname, '..', '..', 'services', 'backend', 'src', 'services', 'a2a');
const MCP_DIR = path.join(__dirname, '..', '..', 'services', 'backend', 'src', 'services', 'domain', 'messaging', 'mcp');

const { TaskStore } = require(path.join(A2A_DIR, 'taskStore.js'));
const { createServerMethods, A2aNotFoundError } = require(path.join(A2A_DIR, 'serverMethods.js'));
const protocol = require(path.join(MCP_DIR, 'mcpServerProtocol.js'));

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  [PASS] ${name}`);
}

(async () => {
  // ── S3: TaskStore ───────────────────────────────────────────────
  const store = new TaskStore();
  const t = store.createTask({ message: { kind: 'message', messageId: 'm1', parts: [{ kind: 'text', text: 'hi' }] } });
  assert.strictEqual(t.status.state, 'submitted', 'new task should be submitted');
  assert.ok(t.id && t.contextId, 'task needs id + contextId');
  ok('TaskStore.createTask → submitted');

  const after = store.appendStatus(t.id, 'working');
  assert.strictEqual(after.status.state, 'working', 'should move to working');
  assert.strictEqual(after.history.length, 2, 'history grows');
  ok('TaskStore.appendStatus → working (history recorded)');

  // 终态不变式:completed 之后不得再迁到 working
  store.appendStatus(t.id, 'completed');
  const blocked = store.appendStatus(t.id, 'working');
  assert.strictEqual(blocked, null, 'terminal state must reject further transition');
  ok('TaskStore 终态不变式:completed 后拒绝 working');

  // cancel 一个非终态任务(终态任务 cancelTask 应返回 null,由 serverMethods 兜底返回原任务)
  const t2 = store.createTask({});
  store.appendStatus(t2.id, 'working');
  const canceled = store.cancelTask(t2.id);
  assert.strictEqual(canceled.status.state, 'canceled', 'cancel → canceled');
  ok('TaskStore.cancelTask → canceled');

  // ── S3: serverMethods.messageSend(默认 executor) ─────────────────
  const methods = createServerMethods();
  const task = await methods.messageSend({
    message: { messageId: 'm2', role: 'user', parts: [{ kind: 'text', text: 'hello world' }] },
  });
  assert.strictEqual(task.status.state, 'completed', 'default executor completes task');
  assert.ok(task.artifacts.length >= 1, 'echo artifact produced');
  ok('serverMethods.messageSend → completed + artifact');

  // tasksGet 命中
  const got = methods.tasksGet({ id: task.id });
  assert.strictEqual(got.id, task.id, 'tasksGet returns same task');
  ok('serverMethods.tasksGet → hit');

  // tasksGet 未命中 → 抛 A2aNotFoundError
  let threw = false;
  try {
    methods.tasksGet({ id: 'nope' });
  } catch (e) {
    threw = e instanceof A2aNotFoundError;
  }
  assert.strictEqual(threw, true, 'tasksGet missing → A2aNotFoundError');
  ok('serverMethods.tasksGet → missing throws A2aNotFoundError');

  // tasksCancel(对非终态任务)
  const ctask = methods.store.createTask({});
  methods.store.appendStatus(ctask.id, 'working');
  const c = methods.tasksCancel({ id: ctask.id });
  assert.strictEqual(c.status.state, 'canceled', 'tasksCancel → canceled');
  ok('serverMethods.tasksCancel → canceled');

  // tasksCancel 对终态任务:不破坏终态,返回原任务(不可从 completed 撤到 canceled)
  const sameCompleted = methods.tasksCancel({ id: task.id });
  assert.strictEqual(sameCompleted.status.state, 'completed', '终态任务 cancel 保持 completed');
  ok('serverMethods.tasksCancel 终态不变式:completed 不被改写');

  // ── S4: MCP 2025-03-26 纯函数 ───────────────────────────────────
  assert.strictEqual(
    protocol.resolveStreamableContentType('application/json, text/event-stream'),
    'text/event-stream',
    'SSE requested → text/event-stream'
  );
  assert.strictEqual(
    protocol.resolveStreamableContentType('application/json'),
    'application/json',
    'plain accept → application/json'
  );
  ok('resolveStreamableContentType 协商 SSE 响应类型');

  const ids = ['1', '2', '3', '4'];
  assert.deepStrictEqual(protocol.replayEventIdsAfter('2', ids), ['3', '4'], 'replay after 2');
  assert.deepStrictEqual(protocol.replayEventIdsAfter('', ids), [], 'empty → no replay');
  assert.deepStrictEqual(protocol.replayEventIdsAfter(undefined, ids), [], 'missing → no replay');
  assert.deepStrictEqual(protocol.replayEventIdsAfter('x', ids), [], 'invalid → no replay');
  ok('replayEventIdsAfter 断线续传切片');

  // 版本声明一致:2025-03-26 进 SUPPORTED 且其 required 全绿
  assert.ok(
    protocol.SUPPORTED_PROTOCOL_VERSIONS.includes('2025-03-26'),
    '2025-03-26 should be declared supported'
  );
  assert.strictEqual(protocol.isRevisionFullyImplemented('2025-03-26'), true, '2025-03-26 required fully implemented');
  ok('SUPPORTED_PROTOCOL_VERSIONS 含 2025-03-26 且 required 全绿');

  console.log(`\n冒烟测试通过:${passed} 项断言全部通过`);
  process.exit(0);
})().catch((err) => {
  console.error('冒烟测试失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
