'use strict';

/**
 * evalTimeout.integration.test.js — 证明 session.evaluate() 的「页内脚本死循环 → page.evaluate 永不
 * resolve → 工具调用卡死」被墙钟兜住(驱动真 evaluate() 代码路径,只把 Playwright 引擎换成假引擎)。
 *
 * ① 门控开 + 低超时:page.evaluate 返回一个**永不 resolve** 的 promise(模拟死循环顶死渲染线程)→
 *    evaluate() 必须在超时内以 { success:false, code:'TIMEOUT' } 返回,且**强制 close 被顶死的标签页**
 *    (page.close 被调用、该页从 tabs 丢弃)。这直接证明「khy 调用工具卡死」在 browser eval 路径被兜住。
 * ② 门控关:逐字节回退今日——直接 await page.evaluate,不设墙钟、不 close。正常脚本立即返回结果。
 *
 * 假引擎:stub engine.loadPlaywright()/acquireBrowser() 让 _ensurePage 拿到假 browser/context/page。
 *
 * 运行:node --test services/backend/tests/services/browser/evalTimeout.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ENGINE_PATH = path.resolve(__dirname, '../../../src/services/browser/engine.js');
const SESSION_PATH = path.resolve(__dirname, '../../../src/services/browser/session.js');

function freshSession() {
  delete require.cache[require.resolve(SESSION_PATH)];
  return require(SESSION_PATH);
}

// 造一个假 page,evaluate 行为可注入(hang=永不 resolve 模拟死循环)。记录 close 是否被调。
function makeFakePage({ hang }) {
  const p = {
    _closed: false,
    url: () => 'about:blank',
    title: async () => '',
    bringToFront: async () => {},
    close: async () => { p._closed = true; },
    evaluate: (fn, src) => {
      if (hang) return new Promise(() => { /* 永不 resolve:模拟被死循环顶死的渲染线程 */ });
      // 非 hang:真正在 Node 里跑 eval(src)(与页内 eval 语义等价,足够单测)。
      // eslint-disable-next-line no-eval
      return Promise.resolve(eval(String(src)));
    },
  };
  return p;
}

function installFakeEngine({ hang }) {
  const engine = require(ENGINE_PATH);
  const pages = [];
  const fakeContext = {
    newPage: async () => { const pg = makeFakePage({ hang }); pages.push(pg); return pg; },
  };
  const fakeBrowser = {
    newContext: async () => fakeContext,
    close: async () => {},
  };
  const orig = { load: engine.loadPlaywright, acquire: engine.acquireBrowser };
  engine.loadPlaywright = () => ({ chromium: {} });
  engine.acquireBrowser = async () => ({ browser: fakeBrowser, isRemote: false });
  return { pages, restore: () => { engine.loadPlaywright = orig.load; engine.acquireBrowser = orig.acquire; } };
}

test('门控开:页内脚本死循环(evaluate 永不 resolve)→ 墙钟超时兜住 + 强制 close 该标签页', async () => {
  const prev = { g: process.env.KHY_BROWSER_EVAL_TIMEOUT, m: process.env.KHY_BROWSER_EVAL_TIMEOUT_MS };
  process.env.KHY_BROWSER_EVAL_TIMEOUT = 'on';
  process.env.KHY_BROWSER_EVAL_TIMEOUT_MS = '1000'; // clamp 下限,足够短
  const eng = installFakeEngine({ hang: true });
  try {
    const session = freshSession();
    const t0 = Date.now();
    const res = await session.evaluate('while(true){}');
    const dt = Date.now() - t0;
    assert.equal(res.success, false, 'hung eval must surface as failure');
    assert.equal(res.code, 'TIMEOUT');
    assert.equal(res.timedOut, true);
    assert.ok(/超时/.test(String(res.error || '')), `error should mention timeout, got: ${res.error}`);
    assert.ok(dt < 4000, `must be bounded by eval timeout (~1s), took ${dt}ms`);
    assert.equal(eng.pages.length, 1, 'exactly one page was created');
    assert.equal(eng.pages[0]._closed, true, 'wedged page must be force-closed');
    // 该页应已从会话 tabs 丢弃(listTabs 反映)。
    const tabs = await session.listTabs();
    assert.equal(tabs.tabs.length, 0, 'wedged page must be dropped from _pages');
  } finally {
    eng.restore();
    if (prev.g === undefined) delete process.env.KHY_BROWSER_EVAL_TIMEOUT; else process.env.KHY_BROWSER_EVAL_TIMEOUT = prev.g;
    if (prev.m === undefined) delete process.env.KHY_BROWSER_EVAL_TIMEOUT_MS; else process.env.KHY_BROWSER_EVAL_TIMEOUT_MS = prev.m;
  }
});

test('门控关:逐字节回退今日——直接 await,不设墙钟、不 close;正常脚本立即返回结果', async () => {
  const prev = process.env.KHY_BROWSER_EVAL_TIMEOUT;
  process.env.KHY_BROWSER_EVAL_TIMEOUT = 'off';
  const eng = installFakeEngine({ hang: false });
  try {
    const session = freshSession();
    const res = await session.evaluate('1 + 2');
    assert.equal(res.success, true, 'normal eval succeeds with gate off');
    assert.equal(res.result, 3);
    assert.equal(eng.pages[0]._closed, false, 'gate off must not close the page');
    const tabs = await session.listTabs();
    assert.equal(tabs.tabs.length, 1, 'gate off keeps the page');
  } finally {
    eng.restore();
    if (prev === undefined) delete process.env.KHY_BROWSER_EVAL_TIMEOUT; else process.env.KHY_BROWSER_EVAL_TIMEOUT = prev;
  }
});

test('门控开 + 正常脚本:墙钟不误伤,返回结果、保留标签页', async () => {
  const prev = { g: process.env.KHY_BROWSER_EVAL_TIMEOUT, m: process.env.KHY_BROWSER_EVAL_TIMEOUT_MS };
  process.env.KHY_BROWSER_EVAL_TIMEOUT = 'on';
  process.env.KHY_BROWSER_EVAL_TIMEOUT_MS = '5000';
  const eng = installFakeEngine({ hang: false });
  try {
    const session = freshSession();
    const res = await session.evaluate('40 + 2');
    assert.equal(res.success, true);
    assert.equal(res.result, 42);
    assert.equal(eng.pages[0]._closed, false, 'healthy eval must not close the page');
  } finally {
    eng.restore();
    if (prev.g === undefined) delete process.env.KHY_BROWSER_EVAL_TIMEOUT; else process.env.KHY_BROWSER_EVAL_TIMEOUT = prev.g;
    if (prev.m === undefined) delete process.env.KHY_BROWSER_EVAL_TIMEOUT_MS; else process.env.KHY_BROWSER_EVAL_TIMEOUT_MS = prev.m;
  }
});
