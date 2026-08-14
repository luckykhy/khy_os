'use strict';

const mockFetchWithTimeout = jest.fn(async (runner) => runner({}));
const mockInstances = [];

jest.mock('../src/services/fetchTimeout', () => ({
  fetchWithTimeout: (...args) => mockFetchWithTimeout(...args),
}));

jest.mock('../src/services/multiFreeService', () => {
  return jest.fn().mockImplementation(() => {
    const inst = {
      providers: {
        openai: { name: 'OpenAI', apiKey: 'env-openai', enabled: true, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
        anthropic: { name: 'Anthropic', apiKey: 'env-anthropic', enabled: false, model: 'claude-sonnet-4-6' },
        trae: { name: 'Trae', apiKey: 'env-trae', enabled: false, model: 'gpt-4o', baseUrl: '' },
        alibaba: { name: 'Alibaba', apiKey: 'env-qwen', enabled: false, model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com' },
        zhipu: { name: 'Zhipu', apiKey: 'env-glm', enabled: false, model: 'glm-4-plus', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
        baidu: { name: 'Baidu', apiKey: 'env-wenxin', enabled: false, model: 'ERNIE-Bot', baseUrl: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop' },
      },
      generateResponse: jest.fn(async (prompt, options) => ({
        success: true,
        content: `ok:${options.provider || 'none'}`,
        provider: options.provider || 'none',
        model: options.model || null,
        attempts: [],
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      })),
      getAvailableProviders: jest.fn(() => [{ key: 'openai', name: 'OpenAI', model: 'gpt-4o-mini' }]),
      getStatus: jest.fn(() => ({ available: true, provider: 'OpenAI', configuredProviders: ['OpenAI'] })),
    };
    mockInstances.push(inst);
    return inst;
  });
});

describe('apiAdapter key override', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInstances.length = 0;
    mockFetchWithTimeout.mockClear();
  });

  test('applies per-request api key + endpoint override for provider-scoped model', async () => {
    const adapter = require('../src/services/gateway/adapters/apiAdapter');
    const result = await adapter.generate('hello', {
      model: 'openai:gpt-4o-mini',
      apiKey: 'override-openai-key',
      apiEndpoint: 'https://proxy.example/v1/',
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.tokenUsage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });

    expect(mockInstances.length).toBeGreaterThan(0);
    const overridden = mockInstances[mockInstances.length - 1];
    expect(overridden.providers.openai.apiKey).toBe('override-openai-key');
    expect(overridden.providers.openai.baseUrl).toBe('https://proxy.example/v1');
    expect(overridden.generateResponse).toHaveBeenCalledTimes(1);
    expect(overridden.generateResponse.mock.calls[0][1].provider).toBe('openai');
    expect(overridden.generateResponse.mock.calls[0][1].model).toBe('gpt-4o-mini');
  });

  test('maps deepseek pool hint to openai provider and default model', async () => {
    const adapter = require('../src/services/gateway/adapters/apiAdapter');
    const result = await adapter.generate('hello', {
      apiPoolProvider: 'deepseek',
      apiKey: 'override-deepseek-key',
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('deepseek-chat');

    const overridden = mockInstances[mockInstances.length - 1];
    expect(overridden.providers.openai.apiKey).toBe('override-deepseek-key');
    expect(overridden.generateResponse.mock.calls[0][1].provider).toBe('openai');
    expect(overridden.generateResponse.mock.calls[0][1].model).toBe('deepseek-chat');
  });

  test('maps relay pool hint to openai provider and relay default model', async () => {
    const adapter = require('../src/services/gateway/adapters/apiAdapter');
    const result = await adapter.generate('hello', {
      apiPoolProvider: 'relay',
      apiKey: 'override-relay-key',
      apiEndpoint: 'https://relay.example/v1',
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-4o-mini');

    const overridden = mockInstances[mockInstances.length - 1];
    expect(overridden.providers.openai.apiKey).toBe('override-relay-key');
    expect(overridden.providers.openai.baseUrl).toBe('https://relay.example/v1');
    expect(overridden.generateResponse.mock.calls[0][1].provider).toBe('openai');
    expect(overridden.generateResponse.mock.calls[0][1].model).toBe('gpt-4o-mini');
  });
});
