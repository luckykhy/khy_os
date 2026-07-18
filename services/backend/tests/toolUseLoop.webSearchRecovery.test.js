'use strict';

describe('toolUseLoop shell->web_search recovery', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('recovers info-search task when shell probe fails with executor_unavailable', async () => {
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
      if (name === 'web_search') {
        return { success: true, results: [{ title: '热点1' }, { title: '热点2' }], output: 'web ok' };
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
        reply: '<tool_call>{"name":"shell_command","params":{"command":"curl -s \\"https://news.google.com/rss\\" | head -n 5"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        reply: 'done',
      });

    const result = await toolUseLoop.runToolUseLoop('搜一下今天的热点新闻', { chat, maxIterations: 4 });
    const logs = Array.isArray(result.toolCallLog) ? result.toolCallLog : [];
    const shellExec = logs.find(item => item && item.tool === 'shell_command');

    expect(shellExec).toBeTruthy();
    expect(shellExec.result && shellExec.result.success).toBe(true);
    expect(shellExec.result && shellExec.result._autoRecovered).toBe(true);
    expect(shellExec.result && shellExec.result._autoRecoveredTarget).toBe('web_search');
    expect(executeTool).toHaveBeenCalledWith('web_search', { query: '搜一下今天的热点新闻' }, expect.any(Object));
  });

  test('falls back to search when web_search recovery fails', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    process.env.KHY_EXEC_APPROVAL = 'off'; // escape valve: this suite tests recovery, not approval

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'shell_command') {
        return {
          success: false,
          error: {
            code: 'executor_unavailable',
            message: 'Shell executor cannot fork subprocesses right now.',
            retryable: true,
          },
        };
      }
      if (name === 'web_search') {
        return { success: false, error: 'network unavailable' };
      }
      if (name === 'search') {
        return { success: true, result: [{ code: 'sh600000', name: '浦发银行' }], output: 'search ok' };
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
        reply: '<tool_call>{"name":"shell_command","params":{"command":"curl -s \\"https://news.google.com/rss\\" | head -n 5"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        reply: 'done',
      });

    const result = await toolUseLoop.runToolUseLoop('搜一下今天的热点新闻', { chat, maxIterations: 4 });
    const logs = Array.isArray(result.toolCallLog) ? result.toolCallLog : [];
    const shellExec = logs.find(item => item && item.tool === 'shell_command');

    expect(shellExec).toBeTruthy();
    expect(shellExec.result && shellExec.result.success).toBe(true);
    expect(shellExec.result && shellExec.result._autoRecovered).toBe(true);
    expect(shellExec.result && shellExec.result._autoRecoveredTarget).toBe('search');
    expect(executeTool).toHaveBeenCalledWith('web_search', { query: '搜一下今天的热点新闻' }, expect.any(Object));
    expect(executeTool).toHaveBeenCalledWith('search', { keyword: '搜一下今天的热点新闻' }, expect.any(Object));
  });
});
