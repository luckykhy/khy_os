'use strict';

describe('toolUseLoop stopReason normalization', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('continues truncated reply when provider returns max_tokens', async () => {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    const toolUseLoop = require('../src/services/toolUseLoop');

    const chat = jest.fn()
      .mockResolvedValueOnce({
        reply: '第一段：模型会先构建上下文。',
        stopReason: 'max_tokens',
        provider: 'mock',
      })
      .mockResolvedValueOnce({
        reply: '第二段：然后基于概率分布逐步生成后续内容。',
        stopReason: 'stop',
        provider: 'mock',
      });

    const result = await toolUseLoop.runToolUseLoop('解释一下大模型思考原理', {
      chat,
      maxIterations: 4,
    });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.finalResponse).toContain('第一段');
    expect(result.finalResponse).toContain('第二段');
  });
});

