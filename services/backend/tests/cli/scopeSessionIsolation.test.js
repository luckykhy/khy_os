'use strict';

/**
 * scopeSession 的「单槽状态」隔离。
 *
 * messages 的隔离早就做了,但 aiChatState 里还有五个**语义属于单次会话、物理上是
 * 进程级**的字段。它们不跟着换,最坏的一条是越权:pendingTaskGuard 是**单槽**待确认
 * 任务,A 挂起一个危险操作后,B 发一句「确认」就会替 A 确认掉 —— B 既看不到那是什么
 * 操作,也没打算批准它。
 *
 * 这些用例全部离线:只操作 aiChatState / aiLocalState,不触碰模型,也不写会话文件
 * (用不存在的 sessionId → resumePersistedSession 走 NOT_FOUND 分支)。
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-scope-'));

const aiSession = require('../../src/cli/aiSession');
const _chatState = require('../../src/cli/aiChatState');
const _localState = require('../../src/cli/aiLocalState');

/** 用一个几乎不可能已持久化的 id,确保走「新会话」分支。 */
function freshId(tag) {
  return `ilink:test-${tag}-${process.pid}`;
}

beforeEach(() => {
  _localState.liveSessionId = null;
  _chatState.messages = [];
  _chatState.pendingTaskGuard = null;
  _chatState.lastSubstantivePrompt = '';
  _chatState.lastSubstantiveAt = 0;
  _chatState.primedSessionId = null;
  _chatState.lastPrimeTopicTokens = null;
});

test('切到另一个用户: 待确认任务不跟过去(否则对方一句「确认」就是越权)', () => {
  const a = freshId('a1');
  const b = freshId('b1');

  aiSession.scopeSession(a);
  _chatState.pendingTaskGuard = { id: 'rm-rf-tmp', expiresAt: Date.now() + 60_000 };

  aiSession.scopeSession(b);
  assert.strictEqual(_chatState.pendingTaskGuard, null,
    'B 的作用域里绝不能看见 A 挂起的待确认任务');
});

test('切回原用户: 他自己的待确认任务还在(隔离不等于丢失)', () => {
  const a = freshId('a2');
  const b = freshId('b2');

  aiSession.scopeSession(a);
  const guard = { id: 'deploy-prod', expiresAt: Date.now() + 60_000 };
  _chatState.pendingTaskGuard = guard;

  aiSession.scopeSession(b);
  aiSession.scopeSession(a);
  assert.deepStrictEqual(_chatState.pendingTaskGuard, guard,
    'A 回来时应还能确认自己挂起的那个任务');
});

test('「继续」的锚点按会话隔离,不会接上别人的任务', () => {
  const a = freshId('a3');
  const b = freshId('b3');

  aiSession.scopeSession(a);
  _chatState.lastSubstantivePrompt = '把整个 src 目录重构成 TypeScript';
  _chatState.lastSubstantiveAt = 1_700_000_000_000;

  aiSession.scopeSession(b);
  assert.strictEqual(_chatState.lastSubstantivePrompt, '',
    'B 发「继续」时不该拿到 A 的原始需求');
  assert.strictEqual(_chatState.lastSubstantiveAt, 0);

  aiSession.scopeSession(a);
  assert.strictEqual(_chatState.lastSubstantivePrompt, '把整个 src 目录重构成 TypeScript',
    'A 自己的「继续」锚点要留着');
});

test('记忆预热基线按会话隔离', () => {
  const a = freshId('a4');
  const b = freshId('b4');

  aiSession.scopeSession(a);
  _chatState.primedSessionId = a;
  _chatState.lastPrimeTopicTokens = ['quant', 'backtest'];

  aiSession.scopeSession(b);
  assert.strictEqual(_chatState.primedSessionId, null, 'B 应被视作未预热');
  assert.strictEqual(_chatState.lastPrimeTopicTokens, null);
});

test('同 id 重复调用是 no-op,不清掉进行中的单槽状态', () => {
  const a = freshId('a5');
  aiSession.scopeSession(a);
  _chatState.pendingTaskGuard = { id: 'x', expiresAt: Date.now() + 60_000 };
  _chatState.lastSubstantivePrompt = '原始需求';

  const r = aiSession.scopeSession(a);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.reason, 'SAME_ID');
  assert.ok(_chatState.pendingTaskGuard, '同一轮会话内不该被重置');
  assert.strictEqual(_chatState.lastSubstantivePrompt, '原始需求');
});

test('空 id(本地 CLI 路径)完全不介入,单槽状态原样保留', () => {
  _chatState.pendingTaskGuard = { id: 'cli-task', expiresAt: Date.now() + 60_000 };
  _chatState.lastSubstantivePrompt = 'CLI 里的需求';

  const r = aiSession.scopeSession('');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.reason, 'EMPTY_ID');
  assert.ok(_chatState.pendingTaskGuard, 'CLI 显式管理自己的历史,scopeSession 不该插手');
  assert.strictEqual(_chatState.lastSubstantivePrompt, 'CLI 里的需求');
});

test('新会话起步状态 === 冷启动默认值(不是「上一个用户的残留」)', () => {
  const a = freshId('a6');
  aiSession.scopeSession(a);
  _chatState.pendingTaskGuard = { id: 'x', expiresAt: Date.now() + 60_000 };
  _chatState.lastSubstantivePrompt = 'x';
  _chatState.lastSubstantiveAt = 123;
  _chatState.primedSessionId = 'x';
  _chatState.lastPrimeTopicTokens = ['x'];

  aiSession.scopeSession(freshId('a7'));
  assert.deepStrictEqual({
    pendingTaskGuard: _chatState.pendingTaskGuard,
    lastSubstantivePrompt: _chatState.lastSubstantivePrompt,
    lastSubstantiveAt: _chatState.lastSubstantiveAt,
    primedSessionId: _chatState.primedSessionId,
    lastPrimeTopicTokens: _chatState.lastPrimeTopicTokens,
  }, {
    pendingTaskGuard: null,
    lastSubstantivePrompt: '',
    lastSubstantiveAt: 0,
    primedSessionId: null,
    lastPrimeTopicTokens: null,
  }, '默认值必须与 aiChatState 的初始值一致');
});

test('寄存表有上限 —— 陌生用户再多也不会无界增长', () => {
  const guardOf = (i) => ({ id: `task-${i}`, expiresAt: Date.now() + 60_000 });
  const first = freshId('lru-0');

  aiSession.scopeSession(first);
  _chatState.pendingTaskGuard = guardOf(0);

  // 上限 32:切过 40 个不同作用域后,最早那个必然已被淘汰。
  for (let i = 1; i <= 40; i++) {
    aiSession.scopeSession(freshId(`lru-${i}`));
    _chatState.pendingTaskGuard = guardOf(i);
  }

  aiSession.scopeSession(first);
  assert.strictEqual(_chatState.pendingTaskGuard, null,
    '被淘汰的作用域应回落到默认值,而不是拿到别人的 guard');
});

test('绝不抛:异常输入 fail-soft', () => {
  for (const bad of [null, undefined, 0, {}, []]) {
    const r = aiSession.scopeSession(bad);
    assert.strictEqual(r.ok, true, `输入 ${JSON.stringify(bad)} 不该让它失败`);
  }
});
