'use strict';

describe('toolUseLoop guardrails', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('resolves max iterations from env when option is not provided', () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_TOOL_LOOP_MAX_ITERATIONS = '3';
    const toolUseLoop = require('../src/services/toolUseLoop');

    expect(toolUseLoop._resolveMaxIterations(undefined)).toBe(3);
    expect(toolUseLoop._resolveMaxIterations(7)).toBe(7);
  });

  test('keeps widened defaults but clamps iteration and elapsed env overrides to safe bounds', () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_TOOL_LOOP_MAX_ITERATIONS = '999';
    process.env.KHY_TOOL_LOOP_MAX_MS = '999999999';
    const toolUseLoop = require('../src/services/toolUseLoop');

    expect(toolUseLoop.MAX_ITERATIONS).toBe(100);
    expect(toolUseLoop.MAX_ELAPSED_MS_DEFAULT).toBe(600000);
    expect(toolUseLoop._resolveMaxIterations(undefined)).toBe(100);
    expect(toolUseLoop._resolveMaxIterations(250)).toBe(100);
    expect(toolUseLoop._resolveMaxElapsedMs()).toBe(1800000);
  });

  test('marks idle-timeout explicitly (not max-iterations)', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_TOOL_LOOP_MAX_MS = '5000';
    const toolUseLoop = require('../src/services/toolUseLoop');

    // Base the fake clock on the real one. Only the 6000 ms *delta* per call
    // matters to this test, but starting from 0 put the whole process in 1970
    // for as long as the spy was installed -- and runToolUseLoop lazily loads
    // the shared winston logger inside that window (tools/index.js ->
    // shellCommand.js -> gitOperationTracker.js -> utils/logger.js), so
    // winston-daily-rotate-file named its files from epoch 0 and left
    // app-1970-01-01.log / error-1970-01-01.log behind. The audit ledger proved
    // it: those entries' timestamps were 30000 / 42000 / 48000, exact multiples
    // of the 6000 step below.
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => {
      now += 6000;
      return now;
    });

    const chat = jest.fn(async () => ({
      reply: '<tool_call>{"name":"missing_tool","params":{}}</tool_call>',
    }));
    const result = await toolUseLoop.runToolUseLoop('test prompt', { chat, maxIterations: 10 });

    expect(result.timeLimitReached).toBe(true);
    expect(result.maxIterationsReached).toBeUndefined();
    expect(result.finalResponse).toContain('未能取得进展');
  });
});
