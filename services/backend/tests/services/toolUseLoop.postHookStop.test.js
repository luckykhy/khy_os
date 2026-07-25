'use strict';

/**
 * s04 — PostToolUse preventContinuation (graceful stop / hook_stopped_continuation).
 *
 * A PostToolUse hook may signal `preventContinuation` to halt the agent loop
 * after the current tool batch. The loop then concludes cleanly on the next
 * iteration boundary — flagged `hookStopped: true` — instead of issuing another
 * model turn or being mislabelled as having hit the iteration ceiling.
 */

function mockHookSystem(triggerImpl) {
  jest.doMock('../../src/services/hooks/hookSystem', () => ({
    isInitialized: () => true,
    init: () => {},
    registry: { count: 1 },
    trigger: triggerImpl,
  }));
}

function mockToolCalling() {
  jest.doMock('../../src/services/toolCalling', () => ({
    setPreflightContext: jest.fn(),
    executeTool: jest.fn(async () => ({ success: true, output: 'ran' })),
  }));
}

const toolBlock = (id) => ({ name: 'shell_command', input: { command: `echo ${id}` }, id });

describe('toolUseLoop PostToolUse graceful stop', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('preventContinuation halts the loop after the tool, flagged hookStopped', async () => {
    let postCalls = 0;
    mockToolCalling();
    mockHookSystem(async (event) => {
      if (event === 'PostToolUse') {
        postCalls++;
        return { blocked: false, context: { preventContinuation: true, stopReason: 'budget guard' } };
      }
      return { blocked: false, context: {} };
    });

    const toolUseLoop = require('../../src/services/toolUseLoop');

    let turn = 0;
    const chat = jest.fn(async () => {
      turn++;
      // Turn 1 issues a tool call. If the loop did NOT stop, turn 2 would fire.
      return { reply: 'working', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [toolBlock('t1')] };
    });

    const result = await toolUseLoop.runToolUseLoop('run a command', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      sessionId: 'pts-s1',
      requestId: 'pts-r1',
    });

    expect(result.hookStopped).toBe(true);
    expect(postCalls).toBe(1);
    // The model was consulted once (to emit the tool call); the graceful stop
    // returned before any second model turn.
    expect(turn).toBe(1);
    expect(result.maxIterationsReached).toBeUndefined();
  }, 30000);

  test('no preventContinuation → loop proceeds normally', async () => {
    mockToolCalling();
    mockHookSystem(async () => ({ blocked: false, context: {} }));

    const toolUseLoop = require('../../src/services/toolUseLoop');

    let turn = 0;
    const chat = jest.fn(async () => {
      turn++;
      if (turn === 1) return { reply: 'working', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [toolBlock('t1')] };
      return { reply: 'all done with a complete summary of the work performed', provider: 'mock' };
    });

    const result = await toolUseLoop.runToolUseLoop('run a command', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      sessionId: 'pts-s2',
      requestId: 'pts-r2',
    });

    expect(result.hookStopped).toBeUndefined();
    expect(turn).toBe(2); // tool turn + conclusion turn
  }, 30000);
});
