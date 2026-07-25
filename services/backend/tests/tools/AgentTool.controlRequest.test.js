'use strict';

/**
 * s03 权限管线 阶段②：子代理权限冒泡。
 *
 * 验证 onControlRequest 审批通道从父级 execContext 经
 * _context.traceContext 抵达 AgentTool，并被透传进子代理的 runToolUseLoop，
 * 使子代理内的高风险 shell 命令能向宿主发起审批，而非 fail-closed 直接拒绝。
 *
 * 同时回归 progressCallback 键名修复：onAgentProgress 现可被读取到。
 */

describe('s03 AgentTool onControlRequest bubbling', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('forwards traceContext.onControlRequest into the child runToolUseLoop', async () => {
    const runToolUseLoop = jest.fn(async () => ({ finalResponse: 'ok', iterations: 1 }));

    jest.doMock('../../src/services/toolUseLoop', () => ({
      isEnabled: () => true,
      runToolUseLoop,
    }));
    // Avoid pulling the real adapter stack; chat is never invoked because the
    // loop itself is mocked above.
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));

    const agentTool = require('../../src/tools/AgentTool');
    const onControlRequest = jest.fn(async () => ({ behavior: 'deny' }));
    const onAgentProgress = jest.fn();

    const result = await agentTool.execute(
      { prompt: 'do something', subagent_type: 'general-purpose' },
      { traceContext: { onControlRequest, onAgentProgress } }
    );

    expect(result.success).toBe(true);
    expect(runToolUseLoop).toHaveBeenCalledTimes(1);
    const opts = runToolUseLoop.mock.calls[0][1];
    expect(opts.onControlRequest).toBe(onControlRequest);
  });

  test('child loop receives null when no control channel is present', async () => {
    const runToolUseLoop = jest.fn(async () => ({ finalResponse: 'ok', iterations: 1 }));

    jest.doMock('../../src/services/toolUseLoop', () => ({
      isEnabled: () => true,
      runToolUseLoop,
    }));
    jest.doMock('../../src/cli/ai', () => ({ chat: jest.fn(async () => ({ reply: 'unused' })) }));

    const agentTool = require('../../src/tools/AgentTool');

    await agentTool.execute(
      { prompt: 'do something', subagent_type: 'general-purpose' },
      { traceContext: {} }
    );

    expect(runToolUseLoop).toHaveBeenCalledTimes(1);
    const opts = runToolUseLoop.mock.calls[0][1];
    expect(opts.onControlRequest).toBeNull();
  });
});
