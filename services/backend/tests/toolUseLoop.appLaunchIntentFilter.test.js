'use strict';

describe('toolUseLoop app-launch intent filter', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('blocks hallucinated open_app for non app-launch requests', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async () => ({ success: true, output: 'unexpected' }));
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
      setPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"open_app","params":{"name":"夸克"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        reply: '牛顿笑了：我不是被苹果砸出定律，是被重复工具调用砸出来的。',
      });

    const result = await toolUseLoop.runToolUseLoop('讲个蕴含知识点的笑话', { chat, maxIterations: 4 });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.finalResponse).toContain('牛顿笑了');
  });

  test('keeps open_app for explicit app-launch commands', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';

    const executeTool = jest.fn(async (name, params) => {
      if (name === 'open_app') return { success: true, output: `已启动: ${params.name}` };
      return { success: false, error: 'unexpected tool' };
    });
    jest.doMock('../src/services/toolCalling', () => ({
      executeTool,
      clearPreflightContext: jest.fn(),
      setPreflightContext: jest.fn(),
    }));

    const toolUseLoop = require('../src/services/toolUseLoop');
    const chat = jest
      .fn()
      .mockResolvedValueOnce({
        reply: '<tool_call>{"name":"open_app","params":{"name":"夸克"}}</tool_call>',
      })
      .mockResolvedValueOnce({
        reply: '已启动并验证: 夸克',
      });

    const result = await toolUseLoop.runToolUseLoop('打开夸克', { chat, maxIterations: 4 });

    // objectContaining: the loop stamps an enumerable HOOKS_EVALUATED idempotency
    // marker symbol onto params (must be enumerable to survive executeTool's
    // normalization spread), so params is not strictly { name }.
    expect(executeTool).toHaveBeenCalledWith('open_app', expect.objectContaining({ name: '夸克' }), expect.any(Object));
    expect(result.finalResponse).toContain('已启动并验证');
  });
});
