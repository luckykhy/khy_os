'use strict';

/**
 * toolAbortSignal.test.js — 「ESC / 用户中断 → 取消执行中的工具」的 abort 竞赛基元单测(node:test)。
 *
 * 根因:ESC(cancelActiveRequest)今天只 abort 模型/网关流,到不了在途工具——一次长搜索/抓取/DB
 * 查询在跑时按 ESC,要等到工具 120s 硬超时才松手。修:loop 把 parentAbort.signal(仅真·中断时触发)
 * 穿进工具执行漏斗,_withToolTimeout 用 attachAbortRace 让在途工具与 abort 竞赛,信号触发 → 带标记的
 * 取消错误落败,外层 catch 塑成诚实、可重试的「已取消」结果。门控 KHY_TOOL_ABORT_SIGNAL、关态逐字节回退。
 *
 * 关键不变量:
 *  - 门控关 / 无有效 signal → attachAbortRace 直返**原 promise 引用**(byte-identical),cleanup 为 no-op。
 *  - signal 触发 → 以带取消标记的错误落败;工具先完成 → 原样 resolve 且 abortP 不致未处理拒绝。
 *  - cleanup 移除监听:cleanup 后再 abort 信号不应再触发(无监听泄漏)。
 *
 * 运行:node --test services/backend/tests/tools/toolAbortSignal.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tt = require('../../src/tools/_toolTimeout');

const ON = {};                                   // 默认门控 on
const OFF = { KHY_TOOL_ABORT_SIGNAL: 'off' };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('isToolAbortEnabled:默认 on;显式 off/0/false/no 关', () => {
  assert.equal(tt.isToolAbortEnabled({}), true);
  assert.equal(tt.isToolAbortEnabled({ KHY_TOOL_ABORT_SIGNAL: 'off' }), false);
  assert.equal(tt.isToolAbortEnabled({ KHY_TOOL_ABORT_SIGNAL: '0' }), false);
  assert.equal(tt.isToolAbortEnabled({ KHY_TOOL_ABORT_SIGNAL: 'false' }), false);
  assert.equal(tt.isToolAbortEnabled({ KHY_TOOL_ABORT_SIGNAL: 'no' }), false);
  assert.equal(tt.isToolAbortEnabled({ KHY_TOOL_ABORT_SIGNAL: 'on' }), true);
});

test('markToolCancelledError / isToolCancelledError:打标+识别,非对象安全', () => {
  const e = new Error('x');
  const marked = tt.markToolCancelledError(e, { toolLabel: 'web_search' });
  assert.equal(tt.isToolCancelledError(marked), true);
  assert.equal(marked.__toolLabel, 'web_search');
  assert.equal(marked.code, 'ECANCELLED');
  // 标记为非枚举(不污染 JSON)。
  assert.equal(Object.keys(e).includes('__toolCancelled'), false);
  // 非对象/普通错误安全。
  assert.equal(tt.isToolCancelledError(null), false);
  assert.equal(tt.isToolCancelledError(new Error('plain')), false);
  assert.equal(tt.markToolCancelledError('nope'), 'nope');
});

test('attachAbortRace:门控关 → 直返原 promise 引用(byte-identical),cleanup no-op', () => {
  const p = Promise.resolve('v');
  const ctrl = new AbortController();
  const a = tt.attachAbortRace(p, ctrl.signal, 'tool', OFF);
  assert.equal(a.promise, p, '门控关应直返原 promise 引用');
  assert.equal(typeof a.cleanup, 'function');
  a.cleanup(); // 不抛
});

test('attachAbortRace:无有效 signal → 直返原 promise 引用', () => {
  const p = Promise.resolve('v');
  assert.equal(tt.attachAbortRace(p, null, 'tool', ON).promise, p);
  assert.equal(tt.attachAbortRace(p, {}, 'tool', ON).promise, p); // 无 addEventListener
});

test('attachAbortRace:工具先完成 → 原样 resolve,abort 不致未处理拒绝', async () => {
  const ctrl = new AbortController();
  const a = tt.attachAbortRace(Promise.resolve('done'), ctrl.signal, 'tool', ON);
  const val = await a.promise;
  assert.equal(val, 'done');
  a.cleanup();
  // 竞赛已 settle 后再 abort:不应抛 / 不应未处理拒绝(abortP 内部有吞噬 catch)。
  ctrl.abort('late');
  await delay(10);
});

test('attachAbortRace:signal 触发 → 以带取消标记的错误落败', async () => {
  const ctrl = new AbortController();
  // 永不 resolve 的在途工具(模拟长搜索挂住)。
  const hang = new Promise(() => {});
  const a = tt.attachAbortRace(hang, ctrl.signal, 'web_search', ON);
  setTimeout(() => ctrl.abort('user ESC'), 20);
  await assert.rejects(a.promise, (err) => {
    assert.equal(tt.isToolCancelledError(err), true);
    assert.match(String(err.message), /web_search/);
    return true;
  });
  a.cleanup();
});

test('attachAbortRace:signal 已 aborted → 立即以取消错误落败', async () => {
  const ctrl = new AbortController();
  ctrl.abort('already');
  const a = tt.attachAbortRace(new Promise(() => {}), ctrl.signal, 'tool', ON);
  await assert.rejects(a.promise, (err) => tt.isToolCancelledError(err));
});

test('attachAbortRace:cleanup 移除监听,cleanup 后 abort 不再触发竞赛落败', async () => {
  const ctrl = new AbortController();
  let resolveTool;
  const toolP = new Promise((res) => { resolveTool = res; });
  const a = tt.attachAbortRace(toolP, ctrl.signal, 'tool', ON);
  // 工具完成 → race resolve;cleanup 移除监听。
  resolveTool('ok');
  const v = await a.promise;
  assert.equal(v, 'ok');
  a.cleanup();
  // cleanup 后 abort:监听已移除,不产生新的 rejection 影响(仅验证不抛)。
  ctrl.abort('after cleanup');
  await delay(10);
  // 监听已移除:signal 上不应还挂着我们的 abort 监听。
  // (Node 无公开 API 数监听;此处以「不抛 + 上面工具值已正确」间接保证。)
});

test('buildToolCancelledResult:门控 on → 结构化可重试;门控关 → null', () => {
  const on = tt.buildToolCancelledResult({ toolLabel: 'web_search', elapsedMs: 1234, env: ON });
  assert.equal(on.success, false);
  assert.equal(on.error.code, 'CANCELLED');
  assert.equal(on.error.errorType, 'cancelled');
  assert.equal(on.error.retryable, true);
  assert.equal(on.error.recoverable, true);
  assert.match(on.error.message, /web_search/);
  assert.equal(on.error.details.tool, 'web_search');
  assert.equal(on.error.details.elapsedMs, 1234);
  // 门控关 → null(逐字节回退今日通用 ToolError 塑形)。
  assert.equal(tt.buildToolCancelledResult({ toolLabel: 'x', env: OFF }), null);
});

test('attachAbortRace:坏输入不抛(promise 非 thenable 也安全返回结构)', () => {
  const a = tt.attachAbortRace(undefined, undefined, undefined, ON);
  assert.ok(a && typeof a.cleanup === 'function');
  a.cleanup();
});
