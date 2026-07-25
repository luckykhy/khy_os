'use strict';

/**
 * onboarding.test.js — `/onboarding` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不接管;空参=full 调 runOnboarding(注入 needs:()=>true 强制重跑);
 * theme → 经 router 复用 skin;model → 调 gateway.handleGatewaySelectModel;mcp → 经 router 复用 mcp governance;
 * trust → 委托真实 workspace-trust 渲染只读状态;status 只读;未知步骤 → 提示但接管(true);help → 用法。
 * 经 require.cache 桩 formatters/router/onboarding/gateway;绝不触真 IO。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/onboarding');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const ROUTER_PATH = require.resolve('../../../src/cli/router');
const ONBOARDING_PATH = require.resolve('../../../src/cli/onboarding');
const GATEWAY_PATH = require.resolve('../../../src/cli/handlers/gateway');

let calls;
let routeCalls;
let onboardingStub;
let gatewayCalls;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/onboarding');
}

beforeEach(() => {
  calls = { info: [], error: [] };
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
    printSuccess: (m) => calls.info.push(String(m)),
    printWarn: (m) => calls.info.push(String(m)),
  });
  routeCalls = [];
  cacheStub(ROUTER_PATH, {
    route: async (parsed) => { routeCalls.push(parsed); return true; },
  });
  onboardingStub = {
    runOnboarding: async (opts) => { onboardingStub._lastOpts = opts; return { ok: true }; },
    needsOnboarding: () => true,
  };
  cacheStub(ONBOARDING_PATH, onboardingStub);
  gatewayCalls = [];
  cacheStub(GATEWAY_PATH, {
    handleGatewaySelectModel: async (args, options) => { gatewayCalls.push({ args, options }); },
  });
  delete process.env.KHY_ONBOARDING_COMMAND;
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[ROUTER_PATH];
  delete require.cache[ONBOARDING_PATH];
  delete require.cache[GATEWAY_PATH];
  delete process.env.KHY_ONBOARDING_COMMAND;
});

describe('门控关 → 不接管', () => {
  test('KHY_ONBOARDING_COMMAND=0 → false', async () => {
    process.env.KHY_ONBOARDING_COMMAND = '0';
    const { handleOnboarding } = freshHandler();
    const r = await handleOnboarding(null, [], {});
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /未启用|KHY_ONBOARDING_COMMAND/.test(m)));
  });
});

describe('full — 重跑向导', () => {
  test('空参 → full,调 runOnboarding 注入 needs:()=>true', async () => {
    const { handleOnboarding } = freshHandler();
    const r = await handleOnboarding(null, [], {});
    assert.equal(r, true);
    assert.ok(onboardingStub._lastOpts && onboardingStub._lastOpts.deps);
    assert.equal(typeof onboardingStub._lastOpts.deps.needs, 'function');
    assert.equal(onboardingStub._lastOpts.deps.needs(), true);
  });
});

describe('theme / mcp — 经 router 复用既有路径', () => {
  test('theme 无名 → route skin list', async () => {
    const { handleOnboarding } = freshHandler();
    await handleOnboarding(null, ['theme'], {});
    assert.ok(routeCalls.some((p) => p.command === 'skin' && p.subCommand === 'list'));
  });

  test('theme 带名 → route skin set <name>', async () => {
    const { handleOnboarding } = freshHandler();
    await handleOnboarding(null, ['theme', 'dracula'], {});
    const hit = routeCalls.find((p) => p.command === 'skin' && p.subCommand === 'set');
    assert.ok(hit);
    assert.deepEqual(hit.args, ['dracula']);
  });

  test('mcp → route mcp governance', async () => {
    const { handleOnboarding } = freshHandler();
    await handleOnboarding(null, ['mcp'], {});
    assert.ok(routeCalls.some((p) => p.command === 'mcp' && p.subCommand === 'governance'));
  });
});

describe('model — 调 gateway 选择', () => {
  test('model → handleGatewaySelectModel', async () => {
    const { handleOnboarding } = freshHandler();
    await handleOnboarding(null, ['model'], {});
    assert.equal(gatewayCalls.length, 1);
  });
});

describe('trust — 委托真实 workspace-trust,渲染只读状态', () => {
  test('trust → 显示信任状态(folder trust),不再声称无机制;不调 router/gateway/onboarding', async () => {
    let touched = 0;
    onboardingStub.runOnboarding = async () => { touched++; return {}; };
    const { handleOnboarding } = freshHandler();
    const r = await handleOnboarding(null, ['trust'], {});
    assert.equal(r, true);
    assert.equal(touched, 0);
    assert.equal(routeCalls.length, 0);
    assert.equal(gatewayCalls.length, 0);
    // 渲染真实信任状态文案(含「文件夹信任」+ 门控行),绝不再出现旧的「暂无此机制」谎言。
    assert.ok(calls.info.some((m) => /文件夹信任|folder trust/.test(m)));
    assert.ok(calls.info.some((m) => /KHY_WORKSPACE_TRUST/.test(m)));
    assert.ok(!calls.info.some((m) => /暂无此机制/.test(m)));
  });
});

describe('status — 只读', () => {
  test('status 不调 runOnboarding/route/gateway', async () => {
    let touched = 0;
    onboardingStub.runOnboarding = async () => { touched++; return {}; };
    const { handleOnboarding } = freshHandler();
    const r = await handleOnboarding(null, ['status'], {});
    assert.equal(r, true);
    assert.equal(touched, 0);
    assert.equal(gatewayCalls.length, 0);
    assert.ok(calls.info.some((m) => /引导状态/.test(m)));
  });
});

describe('非法语法 / help', () => {
  test('未知子命令 → 提示但接管(true)', async () => {
    const { handleOnboarding } = freshHandler();
    const r = await handleOnboarding(null, ['frobnicate'], {});
    assert.equal(r, true);
    assert.ok(calls.error.some((m) => /未知引导步骤/.test(m)));
  });

  test('help → 用法(true)', async () => {
    const { handleOnboarding } = freshHandler();
    const r = await handleOnboarding(null, ['help'], {});
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /\/onboarding theme/.test(m)));
  });
});
