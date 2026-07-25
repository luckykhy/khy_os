'use strict';

describe('toolUseLoop shell->open_app recovery', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('recovers app-launch task when shell probe fails with executor_unavailable', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off'; // escape valve: this suite tests recovery, not approval

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'shell_command') {
        return {
          success: false,
          error: {
            code: 'executor_unavailable',
            message: 'Shell executor cannot fork subprocesses right now.',
            hint: 'not confirmed host resource exhaustion',
            retryable: true,
          },
        };
      }
      if (name === 'open_app') {
        return { success: true, output: `launched: ${params.name}` };
      }
      return { success: false, error: 'unexpected tool' };
    });

    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"shell_command","params":{"command":"which gimp krita eog feh 2>/dev/null | head -1"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        reply: 'done',
      });

    const result = await toolUseLoop.runToolUseLoop('请执行这个命令并返回结果', { chat, maxIterations: 4 });
    const logs = Array.isArray(result.toolCallLog) ? result.toolCallLog : [];
    const shellExec = logs.find(item => item && item.tool === 'shell_command');

    expect(shellExec).toBeTruthy();
    expect(shellExec.result && shellExec.result.success).toBe(true);
    expect(shellExec.result && shellExec.result._autoRecovered).toBe(true);
    expect(executeTool).toHaveBeenCalledWith('open_app', { name: 'gimp' }, expect.any(Object));
  });
});
