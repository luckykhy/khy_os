'use strict';
/**
 * toolCalling.abortSignalWiring.test.js �?「ESC �?取消执行中的工具」在 toolCalling.executeTool
 * 漏斗里的**端到端接�?*证据(node:test)�?
 *
 * 证明:loop �?abort 信号�?traceContext.abortSignal 传进 executeTool 后—�?
 *  - 门控 KHY_TOOL_ABORT_SIGNAL 开:一个永挂的在途工具在信号 abort 时被**竞赛落败**,executeTool
 *    返回结构化、可重试的「已取消」结�?errorType:'cancelled'),且在有界时间内返�?不再苦等
 *    120s 工具硬超�?�?
 *  - 门控�?同一�?*�?aborted 的信�?*被忽�?工具照常完成(byte-identical 今日行为)�?
 *
 * 运行:node --test services/backend/tests/toolCalling.abortSignalWiring.test.js
 */
// 隔离:关掉正交�?syscall 审批�?+ 交互授权,复用已验证的 dangerous 模式路径(�?
// toolCalling.builtinSchemaValidation.test.js)�?
process.env.KHYQUANT_DANGEROUS = 'true';
process.env.KHY_SYSCALL_GATEWAY = 'off';
const toolCalling = require('../src/services/toolCalling');
toolCalling.enableDangerousMode();
// 一个永�?resolve 的在途工�?模拟长搜�?抓取挂住)+ 一�?30ms 后完成的快工具�?
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

describe('Tool Calling abort Signal Wiring', () => {
  test('门控 on:永挂工具 + 信号 abort �?结构化「已取消」结�?有界时间返回(不苦等硬超时)', async () => {
      await withEnv('KHY_TOOL_ABORT_SIGNAL', 'on', async () => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort('user ESC'), 30);
        const started = Date.now();
        const result = await toolCalling.executeTool('abort_probe_hang', {}, {
          abortSignal: ctrl.signal,
        });
        const elapsed = Date.now() - started;
        expect(result.success).toBe(false);
        // 诚实、可重试的取消塑�?区别�?timeout)�?
        expect(result.error && result.error.errorType).toBe('cancelled');
        expect(result.error.code).toBe('CANCELLED');
        expect(result.error.retryable).toBe(true);
        // 远快�?120s 工具硬超时——证�?abort 竞赛真把在途调用松开了�?
        expect(elapsed < 5000).toBeTruthy();
        expect(_hangStarted).toBe(true);
      });
  });

  test('门控 off:�?aborted 的信号被忽略,工具照常完成(byte-identical 今日行为)', async () => {
      await withEnv('KHY_TOOL_ABORT_SIGNAL', 'off', async () => {
        const ctrl = new AbortController();
        ctrl.abort('pre-aborted'); // 门控开时会立即取消;门控关应无视�?
        const result = await toolCalling.executeTool('abort_probe_quick', {}, {
          abortSignal: ctrl.signal,
        });
        expect(result.success).toBe(true);
        expect(result.output).toBe('ok');
      });
  });

  test('无信�?与今日完全一�?工具正常完成,不受本特性影�?', async () => {
      await withEnv('KHY_TOOL_ABORT_SIGNAL', 'on', async () => {
        const result = await toolCalling.executeTool('abort_probe_quick', {}, {});
        expect(result.success).toBe(true);
        expect(result.output).toBe('ok');
      });
  });

});

