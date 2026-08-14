'use strict';

/**
 * autonomy.test.js — `/autonomy` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不接管;非法语法 → 用法/未知提示但接管(true);
 * status 采快照渲染概览;--deep(经 options 桥接)走 buildDeep;
 * flow cancel/resume **委托既有 orchestrationService**(不另起炉灶);缺 id → 用法。
 * 经 require.cache 桩 formatters + orchestrationService;绝不触真 IO。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/autonomy');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const ORCH_PATH = require.resolve('../../../src/services/orchestrator/orchestrationService');

let calls;
let orchStub;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/autonomy');
}

beforeEach(() => {
  calls = { info: [], error: [], success: [], warn: [] };
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
    printSuccess: (m) => calls.success.push(String(m)),
    printWarn: (m) => calls.warn.push(String(m)),
  });
  orchStub = {
    orchestrateEnabled: () => true,
    listRuns: () => [{ runId: 'r1', control: 'running', progress: { done: 1, total: 3 }, mode: 'seq', label: 'demo' }],
    getRunStatus: (id) => (id === 'r1'
      ? { runId: 'r1', mode: 'seq', control: 'running', label: 'demo', progress: { done: 1, total: 3 }, steps: [] }
      : null),
    cancelRun: (id) => (id === 'r1' ? { runId: 'r1', control: 'cancelled' } : null),
    resumeRun: async (id) => (id === 'r1' ? { runId: 'r1', control: 'done' } : null),
  };
  cacheStub(ORCH_PATH, orchStub);
  delete process.env.KHY_AUTONOMY;
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[ORCH_PATH];
  delete process.env.KHY_AUTONOMY;
});

describe('门控关 → 不接管', () => {
  test('KHY_AUTONOMY=0 → false', async () => {
    process.env.KHY_AUTONOMY = '0';
    const { handleAutonomy } = freshHandler();
    const r = await handleAutonomy(null, [], {});
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /KHY_AUTONOMY|未启用/.test(m)));
  });
});

describe('status', () => {
  test('空参 → 概览(true)', async () => {
    const { handleAutonomy } = freshHandler();
    const r = await handleAutonomy(null, [], {});
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /自治活动总览/.test(m)));
  });

  test('--deep 经 options 桥接 → buildDeep(明细分节)', async () => {
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['status'], { deep: true });
    assert.ok(calls.info.some((m) => /── 编排运行明细 ──/.test(m)));
  });

  test('status deep(裸 token)同样走 buildDeep', async () => {
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['status', '--deep'], {});
    assert.ok(calls.info.some((m) => /── 编排运行明细 ──/.test(m)));
  });
});

describe('runs / flows', () => {
  test('runs → 列表渲染', async () => {
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['runs'], {});
    assert.ok(calls.info.some((m) => /近期编排运行/.test(m) && /r1/.test(m)));
  });

  test('flows → 列表渲染', async () => {
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['flows'], {});
    assert.ok(calls.info.some((m) => /近期受管 flow/.test(m)));
  });
});

describe('flow view/cancel/resume —— 委托 orchestrationService', () => {
  test('flow <id> → 详情', async () => {
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['flow', 'r1'], {});
    assert.ok(calls.info.some((m) => /Flow r1/.test(m)));
  });

  test('flow <未知 id> → 未找到', async () => {
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['flow', 'nope'], {});
    assert.ok(calls.error.some((m) => /未找到/.test(m)));
  });

  test('flow cancel <id> → 调 cancelRun 并回执', async () => {
    let cancelled = null;
    orchStub.cancelRun = (id) => { cancelled = id; return { runId: id, control: 'cancelled' }; };
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['flow', 'cancel', 'r1'], {});
    assert.equal(cancelled, 'r1');
    assert.ok(calls.success.some((m) => /已取消/.test(m)));
  });

  test('flow resume <id> → 调 resumeRun(async)并回执', async () => {
    let resumed = null;
    orchStub.resumeRun = async (id) => { resumed = id; return { runId: id, control: 'done' }; };
    const { handleAutonomy } = freshHandler();
    await handleAutonomy(null, ['flow', 'resume', 'r1'], {});
    assert.equal(resumed, 'r1');
    assert.ok(calls.success.some((m) => /已恢复/.test(m)));
  });

  test('flow cancel 缺 id → 用法提示(true)', async () => {
    const { handleAutonomy } = freshHandler();
    const r = await handleAutonomy(null, ['flow', 'cancel'], {});
    assert.equal(r, true);
    assert.ok(calls.error.some((m) => /用法/.test(m)));
  });
});

describe('非法语法', () => {
  test('未知子命令 → 提示但接管(true)', async () => {
    const { handleAutonomy } = freshHandler();
    const r = await handleAutonomy(null, ['frobnicate'], {});
    assert.equal(r, true);
    assert.ok(calls.error.some((m) => /未知子命令/.test(m)));
  });
});
