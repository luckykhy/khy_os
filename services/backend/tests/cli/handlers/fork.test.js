'use strict';

/**
 * fork.test.js — `/fork` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不写;无源会话 → 友好报错不写;有 live → restore→persist(新 id)→resume
 * 切过去;无 live 退最近持久会话;--at 传入 leafUuid;persist 出错友好转述;源会话**绝不**被改
 * (只新增副本)。经 require.cache 桩 formatters / ai / sessionPersistence。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/fork');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const AI_PATH = require.resolve('../../../src/cli/ai');
const SP_PATH = require.resolve('../../../src/services/sessionPersistence');

let calls;
let aiState;
let spState;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function installStubs() {
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printSuccess: (m) => calls.success.push(String(m)),
    printWarn: (m) => calls.warn.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
  });
  cacheStub(AI_PATH, {
    getLiveSessionId: () => aiState.liveId,
    resumePersistedSession: (id) => {
      aiState.resumedWith = id;
      return aiState.resumeResult;
    },
  });
  cacheStub(SP_PATH, {
    listPersistedSessions: () => spState.list,
    restoreSession: (id, opts) => {
      spState.restoreCalls.push({ id, opts });
      return spState.snapshotFor(id);
    },
    persistSession: (id, state) => {
      spState.persistCalls.push({ id, state });
      if (spState.persistThrows) throw new Error('disk full');
      return spState.newId;
    },
  });
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/fork');
}

beforeEach(() => {
  calls = { info: [], success: [], warn: [], error: [] };
  aiState = {
    liveId: 'live-001',
    resumedWith: null,
    resumeResult: { success: true, sessionId: 'new-999', messageCount: 2 },
  };
  spState = {
    list: [],
    newId: 'new-999',
    persistThrows: false,
    restoreCalls: [],
    persistCalls: [],
    snapshotFor: (id) => ({
      sessionId: id,
      title: '源会话',
      model: 'm1',
      metadata: { cwd: '/proj' },
      messages: [
        { role: 'user', content: 'a', uuid: 'u1', timestamp: 1, _khyTrace: { z: 1 } },
        { role: 'assistant', content: 'b', uuid: 'u2', timestamp: 2 },
      ],
    }),
  };
  delete process.env.KHY_FORK;
  process.env.KHY_REPL_ACTIVE = '1';
  installStubs();
});

afterEach(() => {
  for (const p of [HANDLER_PATH, FORMATTERS_PATH, AI_PATH, SP_PATH]) delete require.cache[p];
  delete process.env.KHY_FORK;
  delete process.env.KHY_REPL_ACTIVE;
});

describe('门控关 → 不接管', () => {
  test('KHY_FORK=0 → false,绝不 persist', async () => {
    process.env.KHY_FORK = '0';
    const { handleFork } = freshHandler();
    const r = await handleFork('', []);
    assert.equal(r, false);
    assert.equal(spState.persistCalls.length, 0);
    assert.ok(calls.info.some((m) => /KHY_FORK|未启用/.test(m)));
  });
});

describe('门控开 → 分叉当前 live 会话', () => {
  test('restore(live)→persist(null,state)→resume(newId);源不被改', async () => {
    const { handleFork } = freshHandler();
    const r = await handleFork('', []);
    assert.equal(r, true);
    // 从 live 读源
    assert.equal(spState.restoreCalls[0].id, 'live-001');
    // persist 用 null id(自铸新 id),state 已净化(无 uuid/_khyTrace)
    assert.equal(spState.persistCalls.length, 1);
    assert.equal(spState.persistCalls[0].id, null);
    const persistedMsgs = spState.persistCalls[0].state.messages;
    assert.equal(persistedMsgs.length, 2);
    for (const m of persistedMsgs) {
      assert.equal('uuid' in m, false);
      assert.equal('_khyTrace' in m, false);
    }
    assert.equal(spState.persistCalls[0].state.metadata.forkedFrom, 'live-001');
    // 切到新分叉
    assert.equal(aiState.resumedWith, 'new-999');
    assert.ok(calls.success.some((m) => /已分叉/.test(m)));
  });

  test('显式标题 + --at <leafUuid> 透传', async () => {
    const { handleFork } = freshHandler();
    await handleFork('', ['--at', 'leaf-xyz', '岔路', 'A']);
    assert.deepEqual(spState.restoreCalls[0].opts, { leafUuid: 'leaf-xyz' });
    assert.equal(spState.persistCalls[0].state.title, '岔路 A');
  });
});

describe('无 live → 退最近持久会话', () => {
  test('当前项目最近一条作源', async () => {
    aiState.liveId = null;
    spState.list = [
      { sessionId: 'recent-001', cwd: process.cwd() },
      { sessionId: 'other-002', cwd: '/elsewhere' },
    ];
    const { handleFork } = freshHandler();
    const r = await handleFork('', []);
    assert.equal(r, true);
    assert.equal(spState.restoreCalls[0].id, 'recent-001');
    assert.equal(spState.persistCalls.length, 1);
  });

  test('无 live 且无任何持久会话 → 友好报错,不 persist', async () => {
    aiState.liveId = null;
    spState.list = [];
    const { handleFork } = freshHandler();
    const r = await handleFork('', []);
    assert.equal(r, true);
    assert.equal(spState.persistCalls.length, 0);
    assert.ok(calls.error.some((m) => /没有可分叉|没有.*会话/.test(m)));
  });
});

describe('诚实失败', () => {
  test('源快照空 → 报错不 persist', async () => {
    spState.snapshotFor = () => ({ sessionId: 'x', messages: [] });
    const { handleFork } = freshHandler();
    await handleFork('', []);
    assert.equal(spState.persistCalls.length, 0);
    assert.ok(calls.error.some((m) => /没有可分叉的消息|快照为空/.test(m)));
  });

  test('--at 缺值 → 用法提示,不 restore/persist', async () => {
    const { handleFork } = freshHandler();
    await handleFork('', ['--at']);
    assert.equal(spState.restoreCalls.length, 0);
    assert.equal(spState.persistCalls.length, 0);
    assert.ok(calls.error.some((m) => /用法/.test(m)));
  });

  test('persist 抛错 → 友好转述,不假装成功', async () => {
    spState.persistThrows = true;
    const { handleFork } = freshHandler();
    await handleFork('', []);
    assert.equal(calls.success.length, 0);
    assert.ok(calls.error.some((m) => /分叉失败|disk full/.test(m)));
  });

  test('resume 失败 → 分叉已存,警告可手动 resume,不翻红', async () => {
    aiState.resumeResult = { success: false, error: 'NOT_FOUND' };
    const { handleFork } = freshHandler();
    await handleFork('', []);
    // 分叉本身成功(persist 成功)
    assert.ok(calls.success.some((m) => /已分叉/.test(m)));
    assert.ok(calls.warn.some((m) => /切换到分叉失败|session resume/.test(m)));
  });
});
