'use strict';
/**
 * workflowExecutor.userThreading.test.js �?the wire that makes plugin tools
 * "double-usable": a cross-process workflow run must resolve the RUN OWNER's
 * installed plugins. The worker calls defaultPrimitives({ userId: run.userId }),
 * and the executeTool primitive must forward that userId as the third
 * `traceContext` arg so the plugin bridge can resolve per-user.
 *
 * We monkey-patch toolCalling.executeTool (the primitive requires it at call
 * time, so the cached module export is what runs) and assert the traceContext.
 */
const toolCalling = require('../src/services/toolCalling');
const executor = require('../src/services/domain/project/workflow/workflowExecutor.js');

describe('Workflow Executor user Threading', () => {
  test('executeTool primitive forwards ctx.userId as traceContext', async () => {
      const orig = toolCalling.executeTool;
      const calls = [];
      toolCalling.executeTool = async (name, params, traceContext) => {
        calls.push({ name, params, traceContext });
        return { success: true };
      };
      try {
        const prims = executor.defaultPrimitives({ userId: 42 });
        await prims.executeTool('plugin__my-weather__getForecast', { city: 'oslo' });
        expect(calls.length).toBe(1);
        expect(calls[0].name).toBe('plugin__my-weather__getForecast');
        expect(calls[0].params).toEqual({ city: 'oslo' });
        expect(calls[0].traceContext).toEqual({ userId: 42 });
      } finally {
        toolCalling.executeTool = orig;
      }
  });

  test('executeTool primitive passes an empty traceContext when no userId', async () => {
      const orig = toolCalling.executeTool;
      let seen = null;
      toolCalling.executeTool = async (name, params, traceContext) => { seen = traceContext; return { success: true }; };
      try {
        const prims = executor.defaultPrimitives();
        await prims.executeTool('Bash', { command: 'echo hi' });
        expect(seen).toEqual({});
      } finally {
        toolCalling.executeTool = orig;
      }
  });

});

