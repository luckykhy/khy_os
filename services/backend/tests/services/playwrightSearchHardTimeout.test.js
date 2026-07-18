'use strict';

/**
 * playwrightSearchHardTimeout.test.js — 「正在搜索卡死」根因修复的单测(node:test)。
 *
 * 根因:浏览器回退 fetchRenderedHtml 的 launch/newContext/newPage/content 全无界,
 * teardown 只在 finally——某一步 await 楔住 → 整个搜索冻结 + 泄漏僵尸 Chromium。
 * 修复:门控 KHY_SEARCH_BROWSER_HARD_TIMEOUT(默认 on)下整趟浏览器过程与硬墙钟预算
 * 赛跑,到点强制 teardown(close → SIGKILL 本地进程)并返结构化错误,绝不挂死。
 * 门控关 → 逐字节回退旧路径(仅 finally 里 close,无 kill)。
 *
 * 用 engine.__setPlaywrightModuleForTests 注入假 chromium,不需真浏览器。
 *
 * 运行:node --test services/backend/tests/services/playwrightSearchHardTimeout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ps = require('../../src/services/playwrightSearch');
const engine = require('../../src/services/browser/engine');

const never = () => new Promise(() => {});

/**
 * Build a configurable fake `{ chromium }` playwright module + a call recorder.
 * @param {{hangAt?: 'launch'|'newContext'|'newPage'|'goto'|'content',
 *          throwAt?: 'goto'|'content', killedInitially?: boolean}} [cfg]
 */
function makeFake(cfg = {}) {
  const calls = {
    launchOpts: null, launched: 0, browserClosed: 0, contextClosed: 0,
    processCalled: 0, killed: [],
  };
  const page = {
    goto: async () => { if (cfg.throwAt === 'goto') throw new Error('goto boom'); if (cfg.hangAt === 'goto') return never(); },
    waitForSelector: async () => {},
    content: () => {
      if (cfg.throwAt === 'content') return Promise.reject(new Error('content boom'));
      if (cfg.hangAt === 'content') return never();
      return Promise.resolve('<html>ok</html>');
    },
  };
  const context = {
    newPage: () => (cfg.hangAt === 'newPage' ? never() : Promise.resolve(page)),
    setDefaultTimeout: () => {},
    close: async () => { calls.contextClosed += 1; },
  };
  const browser = {
    newContext: () => (cfg.hangAt === 'newContext' ? never() : Promise.resolve(context)),
    close: async () => { calls.browserClosed += 1; },
    process: () => {
      calls.processCalled += 1;
      return {
        killed: cfg.killedInitially === true,
        kill: (sig) => { calls.killed.push(sig); },
      };
    },
  };
  const chromium = {
    launch: (opts) => {
      calls.launchOpts = opts;
      calls.launched += 1;
      return cfg.hangAt === 'launch' ? never() : Promise.resolve(browser);
    },
  };
  return { mod: { chromium }, calls };
}

/** Run `fn` with a scoped env patch, restoring afterward. */
async function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; }
  // Ensure no remote endpoint / proxy leaks a real acquisition path.
  for (const k of ['KHY_PLAYWRIGHT_WS_ENDPOINT', 'KHY_PLAYWRIGHT_CDP_ENDPOINT',
    'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('unavailable:无 playwright → { unavailable: true }', async () => {
  engine.__setPlaywrightModuleForTests(null);
  const r = await ps.fetchRenderedHtml('https://example.com');
  assert.deepEqual(r, { unavailable: true });
});

test('success(门控 on):返 html 并 teardown(close 被调用)', async () => {
  const { mod, calls } = makeFake();
  engine.__setPlaywrightModuleForTests(mod);
  const r = await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: undefined }, () =>
    ps.fetchRenderedHtml('https://example.com'));
  assert.equal(r.success, true);
  assert.equal(r.html, '<html>ok</html>');
  assert.equal(calls.contextClosed, 1);
  assert.equal(calls.browserClosed, 1);
});

test('wedged content(门控 on):到硬预算返结构化错误、不挂死、SIGKILL 本地进程', async () => {
  const { mod, calls } = makeFake({ hangAt: 'content' });
  engine.__setPlaywrightModuleForTests(mod);
  const t0 = Date.now();
  const r = await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: undefined, KHY_SEARCH_BROWSER_BUDGET_MS: '150' }, () =>
    ps.fetchRenderedHtml('https://example.com'));
  const elapsed = Date.now() - t0;
  assert.equal(r.success, false);
  assert.match(r.error, /hard budget/);
  // 未挂死:在预算 + teardown 界内返回(远小于任何无界 await)。
  assert.ok(elapsed < 5000, `elapsed ${elapsed}ms should be well under 5s`);
  // 强制 teardown 到达 SIGKILL。
  assert.ok(calls.killed.includes('SIGKILL'), 'expected local Chromium SIGKILL');
  assert.equal(calls.browserClosed, 1);
});

test('wedged newContext(门控 on):browser 已获取仍能 teardown+SIGKILL', async () => {
  const { mod, calls } = makeFake({ hangAt: 'newContext' });
  engine.__setPlaywrightModuleForTests(mod);
  const r = await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: undefined, KHY_SEARCH_BROWSER_BUDGET_MS: '150' }, () =>
    ps.fetchRenderedHtml('https://example.com'));
  assert.equal(r.success, false);
  assert.match(r.error, /hard budget/);
  assert.ok(calls.killed.includes('SIGKILL'));
  // context 从未 resolve → 未 close;browser 有 → close 被调。
  assert.equal(calls.contextClosed, 0);
  assert.equal(calls.browserClosed, 1);
});

test('run 抛错(门控 on):归一为 fetch failed、仍 teardown、无 budget 误报', async () => {
  const { mod, calls } = makeFake({ throwAt: 'goto' });
  engine.__setPlaywrightModuleForTests(mod);
  const r = await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: undefined }, () =>
    ps.fetchRenderedHtml('https://example.com'));
  assert.equal(r.success, false);
  assert.match(r.error, /fetch failed/);
  assert.doesNotMatch(r.error, /hard budget/);
  assert.equal(calls.browserClosed, 1);
});

test('门控关:逐字节回退旧路径(success 正常、绝不 SIGKILL)', async () => {
  const { mod, calls } = makeFake();
  engine.__setPlaywrightModuleForTests(mod);
  const r = await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: 'off' }, () =>
    ps.fetchRenderedHtml('https://example.com'));
  assert.equal(r.success, true);
  assert.equal(r.html, '<html>ok</html>');
  assert.equal(calls.browserClosed, 1);
  // 旧路径没有强杀语义。
  assert.equal(calls.killed.length, 0);
  assert.equal(calls.processCalled, 0);
});

test('engine.acquireBrowser:门控 on 注入 launch timeout;门控关不注入(逐字节)', async () => {
  const onFake = makeFake();
  engine.__setPlaywrightModuleForTests(onFake.mod);
  await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: undefined, KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS: '12345' }, async () => {
    await engine.acquireBrowser(onFake.mod.chromium);
  });
  assert.equal(onFake.calls.launchOpts.timeout, 12345);

  const offFake = makeFake();
  engine.__setPlaywrightModuleForTests(offFake.mod);
  await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: 'off', KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS: '12345' }, async () => {
    await engine.acquireBrowser(offFake.mod.chromium);
  });
  assert.equal('timeout' in offFake.calls.launchOpts, false);
});

test('engine.launchTimeoutMs:默认 15000;env 覆盖;非法回默认', () => {
  const saved = process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS;
  try {
    delete process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS;
    assert.equal(engine.launchTimeoutMs(), 15000);
    process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS = '8000';
    assert.equal(engine.launchTimeoutMs(), 8000);
    process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS = 'abc';
    assert.equal(engine.launchTimeoutMs(), 15000);
    process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS = '0';
    assert.equal(engine.launchTimeoutMs(), 15000); // <=0 回默认
  } finally {
    if (saved === undefined) delete process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS;
    else process.env.KHY_PLAYWRIGHT_LAUNCH_TIMEOUT_MS = saved;
  }
});

test('teardown 幂等:多路径不重复强杀(killedInitially → 不再 kill)', async () => {
  const { mod, calls } = makeFake({ hangAt: 'content', killedInitially: true });
  engine.__setPlaywrightModuleForTests(mod);
  const r = await withEnv({ KHY_SEARCH_BROWSER_HARD_TIMEOUT: undefined, KHY_SEARCH_BROWSER_BUDGET_MS: '150' }, () =>
    ps.fetchRenderedHtml('https://example.com'));
  assert.equal(r.success, false);
  // proc.killed === true → 不再补 SIGKILL(避免对已退出进程重复发信号)。
  assert.equal(calls.killed.length, 0);
});
