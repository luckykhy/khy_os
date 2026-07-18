'use strict';

describe('toolUseLoop app-launch interruption fallback', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('returns concrete open_app failure when AI channel is interrupted after shell executor error', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'shell_command') {
        return {
          success: false,
          error: {
            code: 'executor_unavailable',
            message: 'Shell executor cannot fork subprocesses right now.',
          },
        };
      }
      if (name === 'open_app') {
        return {
          success: false,
          error: 'No graphical session detected (DISPLAY/WAYLAND_DISPLAY is not set). Unable to open GUI applications from this terminal session.',
        };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"shell_command","params":{"command":"which feishu || which Feishu || find /usr/bin /usr/local/bin /opt -name feishu"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        errorType: 'process',
        reply: 'canceled',
        provider: 'claude',
      });

    const result = await toolUseLoop.runToolUseLoop('打开飞书', { chat, maxIterations: 4 });

    expect(result.stopped).toBe(true);
    expect(result.recoveredFromInterruptedChannel).toBe(true);
    expect(result.finalResponse).toContain('打开应用');
    expect(result.finalResponse).toContain('No graphical session detected');
    expect(result.finalResponse).toContain('AI 通道在结果整理阶段中断（process）');
    const openAppCalls = executeTool.mock.calls.filter(([toolName]) => toolName === 'open_app');
    expect(openAppCalls.length).toBeGreaterThan(0);
    expect(['飞书', 'feishu']).toContain(openAppCalls[0][1]?.name);
  });

  test('returns successful app-launch output when fallback open_app succeeds', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'shell_command') {
        return {
          success: false,
          error: {
            code: 'executor_unavailable',
            message: 'Shell executor cannot fork subprocesses right now.',
          },
        };
      }
      if (name === 'open_app') {
        return {
          success: true,
          output: `已在后台启动: ${params.name}`,
        };
      }
      return { success: false, error: `unexpected tool: ${name}` };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"bash","params":{"command":"which feishu || which Feishu"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        errorType: 'process',
        reply: 'canceled',
        provider: 'claude',
      });

    const result = await toolUseLoop.runToolUseLoop('打开飞书', { chat, maxIterations: 4 });

    expect(result.stopped).toBe(true);
    expect(result.recoveredFromInterruptedChannel).toBe(true);
    expect(result.finalResponse).toContain('已在后台启动');
    expect(result.finalResponse).toContain('AI 通道在结果整理阶段中断（process）');
  });
});
