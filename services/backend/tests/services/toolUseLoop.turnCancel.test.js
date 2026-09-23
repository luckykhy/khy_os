'use strict';

/**
 * toolUseLoop.turnCancel.test.js — G-B 协作式取消：外部 abort 在 phase 边界干净收尾。
 *
 * 缺口：外部 abortSignal/ESC 只松手批次内剩余工具（parentAbort break），外层 while
 * 随即重入并再发一次 chat()。修复：迭代顶部检测 externalSignal.aborted → 以既有
 * { cancelled:true, stopped:true } 形状收尾，不再重发模型。门控
 * KHY_TURN_CANCEL_PHASE_BOUNDARY（默认开）。
 *
 * 判据用 externalSignal.aborted 而非 parentAbort，故 /i 暂停（interruptSignal 另一条路）
 * 不被误杀（ZCode #174 教训）。关闸门 → 逐字节回退「继续重发」。
 *
 * 隔离：不驱动真实网关/工具/registry —— 依赖注入 chat + 桩 toolCalling（同 postHookStop 套件）。
 */

function mockToolCalling(onExec) {
  jest.doMock('../../src/services/tool/toolCalling', () => ({
    setPreflightContext: jest.fn(),
    executeTool: jest.fn(async () => {
      if (onExec) onExec();
      return { success: true, output: 'ran' };
    }),
  }));
}

function mockHookSystemPassthrough() {
  jest.doMock('../../src/services/domain/extensions/hooks/hookSystem.js', () => ({
    isInitialized: () => true,
    init: () => {},
    registry: { count: 0 },
    trigger: async () => ({ blocked: false, context: {} }),
  }));
}

const toolBlock = (id) => ({ name: 'shell_command', input: { command: `echo ${id}` }, id });

describe('G-B turn-cancel at phase boundary (external abort)', () => {
  const saved = process.env.KHY_TURN_CANCEL_PHASE_BOUNDARY;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (saved === undefined) delete process.env.KHY_TURN_CANCEL_PHASE_BOUNDARY;
    else process.env.KHY_TURN_CANCEL_PHASE_BOUNDARY = saved;
  });

  test('gate ON: external abort mid-tool stops the loop before the next model round', async () => {
    delete process.env.KHY_TURN_CANCEL_PHASE_BOUNDARY; // default-on
    const ctrl = new AbortController();
    mockHookSystemPassthrough();
    mockToolCalling(() => ctrl.abort('user cancelled'));

    const toolUseLoop = require('../../src/services/toolUseLoop');
    let turn = 0;
    const chat = jest.fn(async () => {
      turn++;
      if (turn === 1) {
        return { reply: 'working', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [toolBlock('t1')] };
      }
      // Would only be reached if the loop failed to cancel at the boundary.
      return { reply: 'all done with a complete summary', provider: 'mock' };
    });

    const result = await toolUseLoop.runToolUseLoop('run a command', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      abortSignal: ctrl.signal,
      sessionId: 'gb-s1',
      requestId: 'gb-r1',
    });

    expect(result.cancelled).toBe(true);
    expect(result.stopped).toBe(true);
    // The model was consulted once (to emit the tool call); the cancel returned
    // at the next phase boundary BEFORE any second model turn.
    expect(turn).toBe(1);
  }, 30000);

  test('gate OFF: byte-identical legacy behavior — loop re-issues the model round', async () => {
    process.env.KHY_TURN_CANCEL_PHASE_BOUNDARY = 'off';
    const ctrl = new AbortController();
    mockHookSystemPassthrough();
    mockToolCalling(() => ctrl.abort('user cancelled'));

    const toolUseLoop = require('../../src/services/toolUseLoop');
    let turn = 0;
    const chat = jest.fn(async () => {
      turn++;
      if (turn === 1) {
        return { reply: 'working', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [toolBlock('t1')] };
      }
      return { reply: 'all done with a complete summary', provider: 'mock' };
    });

    const result = await toolUseLoop.runToolUseLoop('run a command', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      abortSignal: ctrl.signal,
      sessionId: 'gb-s2',
      requestId: 'gb-r2',
    });

    // Legacy: no cancel flag, loop proceeds to a second model round and concludes.
    expect(result.cancelled).toBeUndefined();
    expect(turn).toBe(2);
  }, 30000);

  test('no abort: normal loop unaffected by the new guard', async () => {
    delete process.env.KHY_TURN_CANCEL_PHASE_BOUNDARY;
    mockHookSystemPassthrough();
    mockToolCalling(null);

    const toolUseLoop = require('../../src/services/toolUseLoop');
    let turn = 0;
    const chat = jest.fn(async () => {
      turn++;
      if (turn === 1) {
        return { reply: 'working', stopReason: 'tool_use', provider: 'mock', toolUseBlocks: [toolBlock('t1')] };
      }
      return { reply: 'all done with a complete summary', provider: 'mock' };
    });

    const result = await toolUseLoop.runToolUseLoop('run a command', {
      chat,
      chatOpts: { cwd: process.cwd() },
      maxIterations: 12,
      sessionId: 'gb-s3',
      requestId: 'gb-r3',
    });

    expect(result.cancelled).toBeUndefined();
    expect(turn).toBe(2);
  }, 30000);
});
