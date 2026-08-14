'use strict';

/**
 * proactive.test.js — `/proactive` 薄壳契约(node:test)。
 *
 * 锁定:门控关 → false 不接管;空参=toggle 切换;on/off 调既有 assistant.activate/deactivate(仅真变化时);
 * status 只读不切;未知子命令 → 提示但接管(true);切换后再采状态透出结果(含 assistantMode 透明披露)。
 * 经 require.cache 桩 formatters + assistant;绝不触真 IO/真定时器。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const HANDLER_PATH = require.resolve('../../../src/cli/handlers/proactive');
const FORMATTERS_PATH = require.resolve('../../../src/cli/formatters');
const ASSISTANT_PATH = require.resolve('../../../src/assistant');

let calls;
let assistantStub;
let state;

function cacheStub(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

function freshHandler() {
  delete require.cache[HANDLER_PATH];
  return require('../../../src/cli/handlers/proactive');
}

beforeEach(() => {
  calls = { info: [], error: [] };
  cacheStub(FORMATTERS_PATH, {
    printInfo: (m) => calls.info.push(String(m)),
    printError: (m) => calls.error.push(String(m)),
    printSuccess: (m) => calls.info.push(String(m)),
    printWarn: (m) => calls.info.push(String(m)),
  });
  state = { active: false };
  assistantStub = {
    activate: () => { state.active = true; },
    deactivate: () => { state.active = false; },
    getStatus: () => ({
      active: state.active,
      proactive: state.active,
      dreamNeeded: false,
      dreamReason: '',
      lastDream: 'never',
    }),
  };
  cacheStub(ASSISTANT_PATH, assistantStub);
  delete process.env.KHY_PROACTIVE_COMMAND;
});

afterEach(() => {
  delete require.cache[HANDLER_PATH];
  delete require.cache[FORMATTERS_PATH];
  delete require.cache[ASSISTANT_PATH];
  delete process.env.KHY_PROACTIVE_COMMAND;
});

describe('门控关 → 不接管', () => {
  test('KHY_PROACTIVE_COMMAND=0 → false', async () => {
    process.env.KHY_PROACTIVE_COMMAND = '0';
    const { handleProactive } = freshHandler();
    const r = await handleProactive(null, [], {});
    assert.equal(r, false);
    assert.ok(calls.info.some((m) => /未启用|KHY_PROACTIVE_COMMAND/.test(m)));
  });
});

describe('toggle / on / off', () => {
  test('空参 → toggle 从关到开,调 activate', async () => {
    const { handleProactive } = freshHandler();
    const r = await handleProactive(null, [], {});
    assert.equal(r, true);
    assert.equal(state.active, true);
    assert.ok(calls.info.some((m) => /已开启/.test(m)));
  });

  test('on 已开 → no-op,不重复 activate(本就已开启)', async () => {
    state.active = true;
    let activated = 0;
    assistantStub.activate = () => { activated++; state.active = true; };
    const { handleProactive } = freshHandler();
    await handleProactive(null, ['on'], {});
    assert.equal(activated, 0);
    assert.ok(calls.info.some((m) => /本就已开启/.test(m)));
  });

  test('off 从开到关,调 deactivate', async () => {
    state.active = true;
    const { handleProactive } = freshHandler();
    await handleProactive(null, ['off'], {});
    assert.equal(state.active, false);
    assert.ok(calls.info.some((m) => /已关闭/.test(m)));
  });

  test('off 已关 → no-op(本就已关闭)', async () => {
    let deactivated = 0;
    assistantStub.deactivate = () => { deactivated++; state.active = false; };
    const { handleProactive } = freshHandler();
    await handleProactive(null, ['off'], {});
    assert.equal(deactivated, 0);
    assert.ok(calls.info.some((m) => /本就已关闭/.test(m)));
  });
});

describe('status — 只读不切', () => {
  test('status 不调 activate/deactivate', async () => {
    let touched = 0;
    assistantStub.activate = () => { touched++; };
    assistantStub.deactivate = () => { touched++; };
    const { handleProactive } = freshHandler();
    const r = await handleProactive(null, ['status'], {});
    assert.equal(r, true);
    assert.equal(touched, 0);
    assert.ok(calls.info.some((m) => /Proactive idle-tick 模式/.test(m)));
  });
});

describe('非法语法 / help', () => {
  test('未知子命令 → 提示但接管(true)', async () => {
    const { handleProactive } = freshHandler();
    const r = await handleProactive(null, ['frobnicate'], {});
    assert.equal(r, true);
    assert.ok(calls.error.some((m) => /未知子命令/.test(m)));
  });

  test('help → 用法(true)', async () => {
    const { handleProactive } = freshHandler();
    const r = await handleProactive(null, ['help'], {});
    assert.equal(r, true);
    assert.ok(calls.info.some((m) => /\/proactive on/.test(m)));
  });
});
