'use strict';

/**
 * toolCalling.abortSignalWiring.test.js — 「ESC → 取消执行中的工具」在 toolCalling.executeTool
 * 漏斗里的**端到端接线**证据(node:test)。
 *
 * 证明:loop 把 abort 信号经 traceContext.abortSignal 传进 executeTool 后——
 *  - 门控 KHY_TOOL_ABORT_SIGNAL 开:一个永挂的在途工具在信号 abort 时被**竞赛落败**,executeTool
 *    返回结构化、可重试的「已取消」结果(errorType:'cancelled'),且在有界时间内返回(不再苦等
 *    120s 工具硬超时)。
 *  - 门控关:同一个**已 aborted 的信号**被忽略,工具照常完成(byte-identical 今日行为)。
 *
 * 运行:node --test services/backend/tests/toolCalling.abortSignalWiring.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// 隔离:关掉正交的 syscall 审批门 + 交互授权,复用已验证的 dangerous 模式路径(见
// toolCalling.builtinSchemaValidation.test.js)。
process.env.KHYQUANT_DANGEROUS = 'true';
process.env.KHY_SYSCALL_GATEWAY = 'off';

const toolCalling = require('../src/services/toolCalling');
toolCalling.enableDangerousMode();

// 一个永不 resolve 的在途工具(模拟长搜索/抓取挂住)+ 一个 30ms 后完成的快工具。
let _hangStarted = false;
toolCalling.registerTool({
  name: 'abort_probe_hang',
  description: 'test-only: never resolves',
  risk: 'low',
  category: 'read',
  handler: () => new Promise(() => { _hangStarted = true; }),
});
toolCalling.registerTool({
  name: 'abort_probe_quick',
  description: 'test-only: resolves quickly',
  risk: 'low',
  category: 'read',
  handler: () => new Promise((res) => setTimeout(() => res({ success: true, output: 'ok' }), 30)),
});

if (typeof toolCalling.setPreflightContext === 'function') {
  toolCalling.setPreflightContext(new Set(['abort_probe_hang', 'abort_probe_quick']));
}

const withEnv = (key, val, fn) => {
  const saved = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  });
};

test('门控 on:永挂工具 + 信号 abort → 结构化「已取消」结果,有界时间返回(不苦等硬超时)', async () => {
  await withEnv('KHY_TOOL_ABORT_SIGNAL', 'on', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort('user ESC'), 30);
    const started = Date.now();
    const result = await toolCalling.executeTool('abort_probe_hang', {}, {
      abortSignal: ctrl.signal,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.success, false, '应为失败结果');
    // 诚实、可重试的取消塑形(区别于 timeout)。
    assert.equal(result.error && result.error.errorType, 'cancelled', 'errorType 应为 cancelled');
    assert.equal(result.error.code, 'CANCELLED');
    assert.equal(result.error.retryable, true);
    // 远快于 120s 工具硬超时——证明 abort 竞赛真把在途调用松开了。
    assert.ok(elapsed < 5000, `应在 5s 内返回,实际 ${elapsed}ms`);
    assert.equal(_hangStarted, true, '工具 handler 应已真正开始(证明确实进到执行)');
  });
});

test('门控 off:已 aborted 的信号被忽略,工具照常完成(byte-identical 今日行为)', async () => {
  await withEnv('KHY_TOOL_ABORT_SIGNAL', 'off', async () => {
    const ctrl = new AbortController();
    ctrl.abort('pre-aborted'); // 门控开时会立即取消;门控关应无视。
    const result = await toolCalling.executeTool('abort_probe_quick', {}, {
      abortSignal: ctrl.signal,
    });
    assert.equal(result.success, true, '门控关应无视信号、工具正常完成');
    assert.equal(result.output, 'ok');
  });
});

test('无信号:与今日完全一致(工具正常完成,不受本特性影响)', async () => {
  await withEnv('KHY_TOOL_ABORT_SIGNAL', 'on', async () => {
    const result = await toolCalling.executeTool('abort_probe_quick', {}, {});
    assert.equal(result.success, true);
    assert.equal(result.output, 'ok');
  });
});
