'use strict';

/**
 * ilinkDispatcher —— 微信多账号「策略二」执行期工作空间路由(Phase 2.2)。
 *
 * 验证:runExclusive 内、调 chat() 之前,若 accountId 有绑定(getBinding 非 null),
 * 则在本次已全局串行的时间片内把进程级 cwd/agent 切到目标 workspace/agent,查询
 * 结束后(finally)恢复。核心不变量:
 *   1. 有绑定 → 查询期间处于目标 workspace/agent,查询结束后恢复原状;
 *   2. 无绑定 → 全程用默认,绝不触碰路由器;
 *   3. 读绑定抛错 → fail-soft:按「无绑定」继续,chat 照常跑,不抛;
 *   4. 切换抛错 → fail-soft:按「无绑定」继续,chat 照常跑,不抛;
 *   5. chat 抛错 → 恢复仍在 finally 内发生(cwd/agent 都被还原)。
 *
 * 全部离线:注入假 chat / 假通道 / 假 bindingStore / 假 workspace 路由器,
 * 不触模型、不触网络、不触真实 cwd/agent 状态。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离任何 best-effort 落盘(自动检查点/会话持久化),避免污染真实用户目录。
process.env.KHYOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-ilinkroute-'));
process.env.KHY_ILINK_DISABLE_TOOL_LOOP = '1'; // 让注入的假 chat 直接被调
process.env.KHY_ILINK_TYPING_KEEPALIVE_MS = '5';
process.env.KHY_ILINK_QUERY_TIMEOUT_MS = '5000'; // 放宽墙钟上限,避免看门狗误砍
process.env.KHY_DISABLE_SESSION_PERSIST = '1';
process.env.KHY_DISABLE_MEMORY = '1';

const { IlinkDispatcher } = require('../../../src/services/channels/ilinkDispatcher');

/** 只收集出站文本的假通道。 */
function fakeChannel() {
  const out = [];
  return {
    out,
    async sendReply(_c, _t, x) { out.push(String(x)); return { ok: true, sent: 1 }; },
    async setTyping() { return true; },
  };
}

/**
 * 假 workspace 路由器:内存记录当前 cwd/agent 与调用轨迹,不触真实 process 状态。
 * 与生产路由器接口一致:switchCwd / getActiveAgentId / setActiveAgent / clearActiveAgent。
 */
function makeFakeRouter(opts = {}) {
  const state = {
    cwd: opts.initialCwd || '/ws/default',
    agent: 'initialAgent' in opts ? opts.initialAgent : 'defaultAgent',
  };
  const calls = { switchCwd: [], setActiveAgent: [], clearActiveAgent: 0, getActiveAgentId: 0 };
  return {
    state,
    calls,
    switchCwd(dir) {
      calls.switchCwd.push(dir);
      if (opts.throwOnSwitchCwd) throw new Error('boom: switchCwd 炸了');
      state.cwd = dir;
      return { switched: true, cwd: dir, chdirOk: true, syncedEnv: true };
    },
    getActiveAgentId() { calls.getActiveAgentId += 1; return state.agent; },
    setActiveAgent(id) {
      calls.setActiveAgent.push(id);
      if (opts.throwOnSetAgent) throw new Error('boom: setActiveAgent 炸了');
      if (Array.isArray(opts.unknownAgents) && opts.unknownAgents.includes(id)) {
        throw new Error(`agent 不存在: ${id}`);
      }
      state.agent = id;
      return { id };
    },
    clearActiveAgent() { calls.clearActiveAgent += 1; state.agent = null; return { cleared: true }; },
  };
}

/** 假 bindingStore:按 map 返回绑定;可选 getBinding 抛错。 */
function makeFakeBindingStore(map = {}, opts = {}) {
  return {
    getBinding(accountId) {
      if (opts.throwOnGet) throw new Error('boom: getBinding 炸了');
      return map[accountId] || null;
    },
  };
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

test('有绑定: 查询期间处于目标 workspace/agent,结束后恢复原状', async () => {
  const router = makeFakeRouter({ initialCwd: '/ws/default', initialAgent: 'defaultAgent' });
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: 'boundAgent' } });

  // 假 chat:在查询进行中快照路由器状态,断言此刻确实处于目标 workspace/agent。
  let snap = null;
  const chat = async () => {
    snap = { cwd: router.state.cwd, agent: router.state.agent };
    return 'ok';
  };

  const d = new IlinkDispatcher({
    channel: fakeChannel(),
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  // 查询期间:确实切到了目标 workspace/agent。
  assert.deepStrictEqual(snap, { cwd: '/ws/bound', agent: 'boundAgent' }, '查询期间应处于目标 workspace/agent');
  // 切换调用:先切 cwd 到目标,再切 agent 到目标。
  assert.strictEqual(router.calls.switchCwd[0], '/ws/bound', '应先切 cwd 到目标 workspace');
  assert.strictEqual(router.calls.setActiveAgent[0], 'boundAgent', '应切 agent 到目标');
  // 结束后:agent 已恢复为初始值;cwd 已被切回(不再是目标 workspace)。
  assert.strictEqual(router.state.agent, 'defaultAgent', '查询结束后 agent 应恢复');
  assert.strictEqual(router.calls.setActiveAgent[1], 'defaultAgent', '恢复应切回初始 agent');
  assert.notStrictEqual(router.state.cwd, '/ws/bound', '查询结束后 cwd 应已切回');
  assert.strictEqual(router.calls.switchCwd.length, 2, 'cwd 应切换两次:进目标 + 恢复');
});

test('有绑定(仅 workspace,agent 空): 只切 cwd,不动 agent,结束恢复', async () => {
  const router = makeFakeRouter({ initialCwd: '/ws/default', initialAgent: 'defaultAgent' });
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: '' } });

  let snap = null;
  const chat = async () => { snap = { cwd: router.state.cwd, agent: router.state.agent }; return 'ok'; };

  const d = new IlinkDispatcher({
    channel: fakeChannel(),
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  assert.strictEqual(snap.cwd, '/ws/bound', '查询期间应处于目标 workspace');
  assert.strictEqual(snap.agent, 'defaultAgent', 'agent 空 → 不切 agent');
  assert.strictEqual(router.calls.setActiveAgent.length, 0, 'agent 空时绝不切 agent');
  assert.notStrictEqual(router.state.cwd, '/ws/bound', '结束后 cwd 应已切回');
});

test('无绑定: 全程用默认,绝不触碰路由器', async () => {
  const router = makeFakeRouter({ initialCwd: '/ws/default', initialAgent: 'defaultAgent' });
  const store = makeFakeBindingStore({}); // botA 无绑定

  let snap = null;
  const chat = async () => { snap = { cwd: router.state.cwd, agent: router.state.agent }; return 'ok'; };

  const ch = fakeChannel();
  const d = new IlinkDispatcher({
    channel: ch,
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  assert.deepStrictEqual(snap, { cwd: '/ws/default', agent: 'defaultAgent' }, '无绑定应全程用默认');
  assert.strictEqual(router.calls.switchCwd.length, 0, '无绑定绝不切 cwd');
  assert.strictEqual(router.calls.setActiveAgent.length, 0, '无绑定绝不切 agent');
  assert.ok(ch.out.join('\n').includes('ok'), '无绑定也应正常回答');
});

test('读绑定抛错: fail-soft,按无绑定继续,chat 照常跑', async () => {
  const router = makeFakeRouter();
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: 'boundAgent' } }, { throwOnGet: true });

  let ran = false;
  const chat = async () => { ran = true; return 'ok'; };

  const ch = fakeChannel();
  const d = new IlinkDispatcher({
    channel: ch,
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  // 不得抛到 handle 之外。
  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  assert.strictEqual(ran, true, '读绑定抛错后 chat 仍应正常跑');
  assert.strictEqual(router.calls.switchCwd.length, 0, '读绑定失败 → 按无绑定,不切 cwd');
  assert.ok(ch.out.join('\n').includes('ok'), '应正常回答,而非报错文本');
});

test('切换抛错: fail-soft,按无绑定继续,chat 照常跑', async () => {
  const router = makeFakeRouter({ throwOnSwitchCwd: true });
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: '' } });

  let snap = null;
  const chat = async () => { snap = { cwd: router.state.cwd, agent: router.state.agent }; return 'ok'; };

  const ch = fakeChannel();
  const d = new IlinkDispatcher({
    channel: ch,
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  // switchCwd 抛错前未改状态 → 查询在默认 cwd 下跑。
  assert.strictEqual(snap.cwd, '/ws/default', '切换失败 → 仍在默认 cwd 下执行');
  assert.strictEqual(router.calls.switchCwd.length, 1, '只尝试了一次切换(抛错),无恢复步骤');
  assert.ok(ch.out.join('\n').includes('ok'), '切换失败也应正常回答');
});

test('读当前 cwd 抛错(目录被删/失权): 放弃 cwd 切换,chat 照常,不抛', async () => {
  // fail-soft 加固:捕获恢复基线的 process.cwd() 抛错时,无法保证精确恢复 →
  // 放弃 cwd 切换、继续默认 cwd。agent 分支独立,仍应正常切换/恢复。
  const router = makeFakeRouter({ initialAgent: 'defaultAgent' });
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: 'boundAgent' } });

  let ran = false;
  const chat = async () => { ran = true; return 'ok'; };

  const ch = fakeChannel();
  const d = new IlinkDispatcher({
    channel: ch,
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  // 模拟 cwd 被删/失权:读当前 cwd 直接抛错(EACCES/ENOENT 语义)。
  const origCwd = process.cwd;
  process.cwd = () => { throw new Error('boom: getcwd ENOENT'); };
  try {
    await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });
  } finally {
    process.cwd = origCwd;
  }

  assert.strictEqual(ran, true, 'cwd 读取抛错后 chat 仍应正常跑');
  assert.strictEqual(router.calls.switchCwd.length, 0, 'cwd 读取失败 → 放弃 cwd 切换(不触 switchCwd)');
  // agent 分支不受 cwd 读取失败影响:切到目标再恢复。
  assert.strictEqual(router.calls.setActiveAgent[0], 'boundAgent', 'agent 分支独立,仍切到目标');
  assert.strictEqual(router.state.agent, 'defaultAgent', '查询结束后 agent 应恢复');
  assert.ok(ch.out.join('\n').includes('ok'), '应正常回答,而非报错文本');
});

test('未知 agent: setActiveAgent 抛错 → fail-soft,用默认 agent 继续', async () => {
  const router = makeFakeRouter({ initialAgent: 'defaultAgent', unknownAgents: ['ghostAgent'] });
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: 'ghostAgent' } });

  let snap = null;
  const chat = async () => { snap = { cwd: router.state.cwd, agent: router.state.agent }; return 'ok'; };

  const d = new IlinkDispatcher({
    channel: fakeChannel(),
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  // cwd 仍切到目标;agent 因不存在而回落默认,不抛。
  assert.strictEqual(snap.cwd, '/ws/bound', 'cwd 应正常切到目标');
  assert.strictEqual(snap.agent, 'defaultAgent', '未知 agent → 用默认 agent 继续');
  assert.notStrictEqual(router.state.cwd, '/ws/bound', '结束后 cwd 应已切回');
});

test('chat 抛错: 恢复仍在 finally 内发生(cwd/agent 都被还原)', async () => {
  const router = makeFakeRouter({ initialCwd: '/ws/default', initialAgent: 'defaultAgent' });
  const store = makeFakeBindingStore({ botA: { workspace: '/ws/bound', agent: 'boundAgent' } });

  let snap = null;
  const chat = async () => {
    // 先快照(证明切换已生效),再抛错。
    snap = { cwd: router.state.cwd, agent: router.state.agent };
    throw new Error('boom: chat 半路炸了');
  };

  const ch = fakeChannel();
  const d = new IlinkDispatcher({
    channel: ch,
    accountId: 'botA',
    getChat: () => chat,
    getBindingStore: () => store,
    getWorkspaceRouter: () => router,
  });

  // 不得抛到 handle 之外(_drain 会兜底成一句中文)。
  await d.handle({ userId: 'u1', channelId: 'u1', text: '你好' });

  // 查询期间确实切到了目标。
  assert.deepStrictEqual(snap, { cwd: '/ws/bound', agent: 'boundAgent' }, 'chat 抛错前应已切到目标');
  // 关键:即便 chat 抛错,恢复仍发生。
  assert.strictEqual(router.state.agent, 'defaultAgent', 'chat 抛错后 agent 仍应恢复');
  assert.strictEqual(router.calls.switchCwd.length, 2, 'chat 抛错后 cwd 恢复步骤仍应执行');
  assert.notStrictEqual(router.state.cwd, '/ws/bound', 'chat 抛错后 cwd 应已切回');
  assert.ok(ch.out.join('\n').includes('⚠️'), 'chat 抛错应兜底成一句可发送的中文');
});
