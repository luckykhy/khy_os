'use strict';

/**
 * workflowExecutor.userThreading.test.js — the wire that makes plugin tools
 * "double-usable": a cross-process workflow run must resolve the RUN OWNER's
 * installed plugins. The worker calls defaultPrimitives({ userId: run.userId }),
 * and the executeTool primitive must forward that userId as the third
 * `traceContext` arg so the plugin bridge can resolve per-user.
 *
 * We monkey-patch toolCalling.executeTool (the primitive requires it at call
 * time, so the cached module export is what runs) and assert the traceContext.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const toolCalling = require('../src/services/toolCalling');
const executor = require('../src/services/workflow/workflowExecutor');

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
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'plugin__my-weather__getForecast');
    assert.deepStrictEqual(calls[0].params, { city: 'oslo' });
    assert.deepStrictEqual(calls[0].traceContext, { userId: 42 });
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
    assert.deepStrictEqual(seen, {});
  } finally {
    toolCalling.executeTool = orig;
  }
});
