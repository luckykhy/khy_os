'use strict';

/**
 * s04 — main-loop Stop hook + stopHookActive anti-runaway.
 *
 * When the turn reaches its natural stopping point (model produced no tool
 * calls), a registered Stop hook may veto the stop by returning `blocked`,
 * forcing exactly one more iteration. The stopHookActive one-shot latch
 * guarantees the second arrival at the stop point is NOT vetoed again, so the
 * loop can never be driven indefinitely by the hook.
 */

const LONG = 'This is a complete and substantive final answer. '.repeat(12); // > 400 non-ws chars → concludeNow shortcut

function mockHookSystem(triggerImpl) {
  jest.doMock('../../src/services/hooks/hookSystem', () => ({
    isInitialized: () => true,
    init: () => {},
    registry: { count: 1 }, // non-zero → _getHookSystem() returns this system
    trigger: triggerImpl,
  }));
}

function mockToolCalling() {
  jest.doMock('../../src/services/toolCalling', () => ({
    setPreflightContext: jest.fn(),
    executeTool: jest.fn(async () => ({ success: true, output: 'ok' })),
  }));
}

describe('toolUseLoop main-loop Stop hook', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('Stop hook vetoes the natural stop, but stopHookActive latch halts runaway', async () => {
    let stopCalls = 0;
    mockToolCalling();
    mockHookSystem(async (event) => {
      if (event === 'Stop') {
        stopCalls++;
        // ALWAYS veto. Without the latch this would loop until maxIterations;
        // with it, only the first veto is honored.
        return { blocked: true, reason: 'keep going', context: {} };
      }
      return { blocked: false, context: {} };
    });

    const toolUseLoop = require('../../src/services/toolUseLoop');

    let turn = 0;
    const chat = jest.fn(async () => {
      turn++;
      return { reply: LONG, provider: 'mock' }; // no tool calls → natural stop each turn
    });

    const result = await toolUseLoop.runToolUseLoop('do the task', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      sessionId: 'stop-s1',
      requestId: 'stop-r1',
    });

    // Turn 1 concludes → Stop veto honored → forced continue → Turn 2 concludes
    // → Stop hook still RUNS (telemetry) but its veto is ignored by the latch →
    // clean return. The latch — not maxIterations — is what stops the loop.
    expect(turn).toBe(2);
    expect(stopCalls).toBe(2);
    expect(result.maxIterationsReached).toBeUndefined();
    expect(result.finalResponse).toContain('substantive final answer');
  }, 30000);

  test('no Stop veto → single conclusion, no forced continuation', async () => {
    let stopCalls = 0;
    mockToolCalling();
    mockHookSystem(async (event) => {
      if (event === 'Stop') { stopCalls++; return { blocked: false, context: {} }; }
      return { blocked: false, context: {} };
    });

    const toolUseLoop = require('../../src/services/toolUseLoop');

    let turn = 0;
    const chat = jest.fn(async () => { turn++; return { reply: LONG, provider: 'mock' }; });

    await toolUseLoop.runToolUseLoop('do the task', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      sessionId: 'stop-s2',
      requestId: 'stop-r2',
    });

    expect(turn).toBe(1);
    expect(stopCalls).toBe(1);
  }, 30000);
});
