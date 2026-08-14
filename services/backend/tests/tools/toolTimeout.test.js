'use strict';

/**
 * toolTimeout.test.js — 工具级模型可设墙钟超时基元的单测(node:test)。
 *
 * 覆盖:
 *  - isToolTimeoutEnabled 默认 on、显式 off 关。
 *  - resolveToolTimeoutMs 优先级(paramMs > env > defaultMs)+ clamp + 门控关回默认。
 *  - withDeadline:快路径原样返回、到点返结构化超时(不抛不挂)、工厂抛错归一为 __error、
 *    onTimeout 清理被调用、坏 factory 安全。
 *
 * 运行:node --test services/backend/tests/tools/toolTimeout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tt = require('../../src/tools/_toolTimeout');

test('isToolTimeoutEnabled 默认 on、显式 off 关', () => {
  assert.equal(tt.isToolTimeoutEnabled({}), true);
  assert.equal(tt.isToolTimeoutEnabled({ KHY_TOOL_TIMEOUT: 'off' }), false);
  assert.equal(tt.isToolTimeoutEnabled({ KHY_TOOL_TIMEOUT: 'false' }), false);
});

test('resolveToolTimeoutMs:paramMs 优先并 clamp', () => {
  assert.equal(tt.resolveToolTimeoutMs({ paramMs: 5000, defaultMs: 30000, min: 1000, max: 120000, env: {} }), 5000);
  // clamp 上下界。
  assert.equal(tt.resolveToolTimeoutMs({ paramMs: 10, defaultMs: 30000, min: 1000, max: 120000, env: {} }), 1000);
  assert.equal(tt.resolveToolTimeoutMs({ paramMs: 999999, defaultMs: 30000, min: 1000, max: 120000, env: {} }), 120000);
});

test('resolveToolTimeoutMs:无 paramMs 时用 env(envKey)', () => {
  const r = tt.resolveToolTimeoutMs({
    envKey: 'KHY_WEBSEARCH_TIMEOUT_MS',
    defaultMs: 30000,
    min: 1000,
    max: 120000,
    env: { KHY_WEBSEARCH_TIMEOUT_MS: '15000' },
  });
  assert.equal(r, 15000);
});

test('resolveToolTimeoutMs:paramMs 与 env 都无 → defaultMs', () => {
  assert.equal(
    tt.resolveToolTimeoutMs({ envKey: 'KHY_X_MS', defaultMs: 20000, min: 1000, max: 120000, env: {} }),
    20000
  );
});

test('resolveToolTimeoutMs:门控关 → 直返 defaultMs(忽略 paramMs/env)', () => {
  const r = tt.resolveToolTimeoutMs({
    paramMs: 5000,
    envKey: 'KHY_WEBSEARCH_TIMEOUT_MS',
    defaultMs: 30000,
    min: 1000,
    max: 120000,
    env: { KHY_TOOL_TIMEOUT: 'off', KHY_WEBSEARCH_TIMEOUT_MS: '9000' },
  });
  assert.equal(r, 30000);
});

test('resolveToolTimeoutMs:坏输入 → 安全默认', () => {
  assert.equal(tt.resolveToolTimeoutMs({ paramMs: 'abc', defaultMs: 30000, min: 1000, max: 120000, env: {} }), 30000);
  assert.equal(tt.resolveToolTimeoutMs(undefined), 30000);
});

test('withDeadline:快路径原样返回被包裹结果', async () => {
  const r = await tt.withDeadline(() => Promise.resolve({ success: true, value: 42 }), 10000);
  assert.deepEqual(r, { success: true, value: 42 });
});

test('withDeadline:到点返结构化超时(绝不抛、绝不悬挂)', async () => {
  const neverResolves = () => new Promise(() => {});
  const r = await tt.withDeadline(neverResolves, 30);
  assert.equal(r.__timedOut, true);
  assert.equal(r.timeoutMs, 30);
  assert.equal(typeof r.message, 'string');
});

test('withDeadline:到点调用 onTimeout 清理回调', async () => {
  let cleaned = false;
  const r = await tt.withDeadline(() => new Promise(() => {}), 30, () => { cleaned = true; });
  assert.equal(r.__timedOut, true);
  assert.equal(cleaned, true);
});

test('withDeadline:被包裹 promise reject → 归一为 __error(不抛)', async () => {
  const r = await tt.withDeadline(() => Promise.reject(new Error('boom')), 10000);
  assert.equal(r.__timedOut, false);
  assert.ok(r.__error instanceof Error);
  assert.equal(r.__error.message, 'boom');
});

test('withDeadline:factory 同步抛 → 归一为 __error(不抛)', async () => {
  const r = await tt.withDeadline(() => { throw new Error('sync-boom'); }, 10000);
  assert.equal(r.__timedOut, false);
  assert.equal(r.__error.message, 'sync-boom');
});

test('buildToolTimeoutGuidanceItem:门控 on 返教学串、off 返 null', () => {
  const on = tt.buildToolTimeoutGuidanceItem({});
  assert.equal(typeof on, 'string');
  assert.match(on, /timeoutMs/);
  assert.equal(tt.buildToolTimeoutGuidanceItem({ KHY_TOOL_TIMEOUT: 'off' }), null);
});

// ── 通用漏斗:模型可设预算 + 诚实可重试超时塑形 ─────────────────────────────

test('resolveToolExecBudgetMs:无 paramMs → 逐字节回退 baseline(今日行为)', () => {
  // 无 env、无 param → 120000(等价 parseInt(env||'120000'))。
  assert.equal(tt.resolveToolExecBudgetMs({ env: {} }), 120000);
  // env 提供 baseline、无 param → 原样透传(不 clamp)。
  assert.equal(tt.resolveToolExecBudgetMs({ env: { KHY_TOOL_EXEC_TIMEOUT_MS: '45000' } }), 45000);
  // env 的「禁用」语义 <=0 原样保留(调用方据此跳过竞赛)。
  assert.equal(tt.resolveToolExecBudgetMs({ env: { KHY_TOOL_EXEC_TIMEOUT_MS: '0' } }), 0);
  assert.equal(tt.resolveToolExecBudgetMs({ env: { KHY_TOOL_EXEC_TIMEOUT_MS: '-5' } }), -5);
  // env 垃圾值 → 落回 120000(今日 parseInt 归一)。
  assert.equal(tt.resolveToolExecBudgetMs({ env: { KHY_TOOL_EXEC_TIMEOUT_MS: 'xyz' } }), 120000);
});

test('resolveToolExecBudgetMs:显式 paramMs 启用并 clamp[1000,1800000]', () => {
  assert.equal(tt.resolveToolExecBudgetMs({ paramMs: 30000, env: {} }), 30000);
  assert.equal(tt.resolveToolExecBudgetMs({ paramMs: 10, env: {} }), 1000);
  assert.equal(tt.resolveToolExecBudgetMs({ paramMs: 99999999, env: {} }), 1800000);
  // paramMs 优先于 env baseline。
  assert.equal(
    tt.resolveToolExecBudgetMs({ paramMs: 60000, env: { KHY_TOOL_EXEC_TIMEOUT_MS: '45000' } }),
    60000
  );
});

test('resolveToolExecBudgetMs:门控关 → 忽略 paramMs,逐字节回退 baseline', () => {
  assert.equal(
    tt.resolveToolExecBudgetMs({ paramMs: 5000, env: { KHY_TOOL_TIMEOUT: 'off', KHY_TOOL_EXEC_TIMEOUT_MS: '45000' } }),
    45000
  );
  assert.equal(
    tt.resolveToolExecBudgetMs({ paramMs: 5000, env: { KHY_TOOL_TIMEOUT: 'off' } }),
    120000
  );
});

test('markToolExecTimeoutError / isToolExecTimeoutError:打标后可识别', () => {
  const e = new Error('Tool execution timeout: grep exceeded 120000ms');
  assert.equal(tt.isToolExecTimeoutError(e), false); // 未打标
  const marked = tt.markToolExecTimeoutError(e, { toolLabel: 'grep', timeoutMs: 120000 });
  assert.equal(marked, e); // 原对象返回
  assert.equal(tt.isToolExecTimeoutError(e), true);
  assert.equal(e.__toolLabel, 'grep');
  assert.equal(e.__timeoutMs, 120000);
  assert.equal(e.code, 'ETIMEDOUT');
  // 标记非枚举(不污染 JSON/日志的默认序列化)。
  assert.equal(Object.keys(e).includes('__toolExecTimeout'), false);
});

test('markToolExecTimeoutError:非对象输入不抛、原样返回', () => {
  assert.equal(tt.markToolExecTimeoutError(null), null);
  assert.equal(tt.markToolExecTimeoutError(undefined), undefined);
  assert.equal(tt.isToolExecTimeoutError(null), false);
  assert.equal(tt.isToolExecTimeoutError('x'), false);
});

test('markToolExecTimeoutError:不覆盖已有 code', () => {
  const e = new Error('boom');
  e.code = 'ECUSTOM';
  tt.markToolExecTimeoutError(e, { toolLabel: 't' });
  assert.equal(e.code, 'ECUSTOM');
  assert.equal(tt.isToolExecTimeoutError(e), true);
});

test('buildToolExecTimeoutResult:门控 on → 诚实可重试结构化结果', () => {
  const r = tt.buildToolExecTimeoutResult({ toolLabel: 'grep', timeoutMs: 120000, elapsedMs: 120001, env: {} });
  assert.equal(r.success, false);
  assert.equal(r.error.code, 'TIMEOUT');
  assert.equal(r.error.errorType, 'timeout');
  assert.equal(r.error.recoverable, true);
  assert.equal(r.error.retryable, true);
  assert.match(r.error.message, /grep/);
  assert.match(r.error.message, /超时/);
  // 诚实说明「非终局失败·可换方法重试」+ 明确点到 timeoutMs 旋钮。
  assert.match(r.error.hint, /重试/);
  assert.match(r.error.hint, /timeoutMs/);
  assert.match(r.error.hint, /网关未中断/);
  assert.equal(r.error.details.tool, 'grep');
  assert.equal(r.error.details.reason, 'tool-exec-timeout');
  assert.equal(r.error.details.timeoutMs, 120000);
  assert.equal(r.error.details.elapsedMs, 120001);
});

test('buildToolExecTimeoutResult:缺 timeoutMs 时消息优雅降级、details 不含该键', () => {
  const r = tt.buildToolExecTimeoutResult({ toolLabel: 't', env: {} });
  assert.equal(r.success, false);
  assert.match(r.error.message, /已达执行时间上限/);
  assert.equal('timeoutMs' in r.error.details, false);
});

test('buildToolExecTimeoutResult:门控关 → null(逐字节回退通用 ToolError 塑形)', () => {
  assert.equal(tt.buildToolExecTimeoutResult({ toolLabel: 'grep', timeoutMs: 1000, env: { KHY_TOOL_TIMEOUT: 'off' } }), null);
});
