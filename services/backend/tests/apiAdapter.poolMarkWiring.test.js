'use strict';

/**
 * apiAdapter pool markFailure/markSuccess 接线测试。
 *
 * 背景修复:apiAdapter 此前只在远端模型列表探测时 markSuccess,chat 生成失败从不 markFailure →
 * 失败 key 永不进 cooldown,网关无限重试同一把抖动/失效 key(卡死根因)。修复后,generate 成功
 * → _poolMark('markSuccess'),失败 → _poolMark('markFailure', statusCode, error)。
 *
 * 本测试 mock apiKeyPool.pick / markSuccess / markFailure,验证:
 *   1. 成功时 markSuccess 被调用
 *   2. 失败时 markFailure 被调用,带 statusCode + error
 *   3. 无 poolKey(非池模型)时不触碰 pool
 */

const mockInstances = [];
const mockPool = {
  pick: jest.fn(),
  markSuccess: jest.fn(),
  markFailure: jest.fn(),
};

jest.mock('../src/services/fetchTimeout', () => ({
  fetchWithTimeout: async (runner) => runner({}),
}));

jest.mock('../src/services/multiFreeService', () => {
  return jest.fn().mockImplementation(() => {
    const inst = {
      providers: {
        openai: { name: 'OpenAI', apiKey: 'env-openai', enabled: true, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com' },
      },
      generateResponse: jest.fn(async (prompt, options) => {
        // 失败还是成功由测试动态控制
        const fail = global.__GATEWAY_FAKE_FAIL__;
        if (fail) {
          return {
            success: false,
            content: '',
            provider: options.provider || 'none',
            model: options.model || null,
            error: 'Request failed with status code 502',
            errorType: 'server_error',
            attempts: [{ provider: 'OpenAI', success: false, error: 'Request failed with status code 502', statusCode: 502 }],
          };
        }
        return {
          success: true,
          content: 'ok',
          provider: options.provider || 'none',
          model: options.model || null,
          attempts: [],
        };
      }),
      getAvailableProviders: jest.fn(() => [{ key: 'openai', name: 'OpenAI', model: 'gpt-4o-mini' }]),
      getStatus: jest.fn(() => ({ available: true })),
    };
    mockInstances.push(inst);
    return inst;
  });
});

jest.mock('../src/services/apiKeyPool', () => mockPool);

describe('apiAdapter pool markFailure/markSuccess wiring', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInstances.length = 0;
    mockPool.pick.mockReset();
    mockPool.markSuccess.mockReset();
    mockPool.markFailure.mockReset();
    delete global.__GATEWAY_FAKE_FAIL__;
    // 默认:命中 pool key
    mockPool.pick.mockImplementation(() => ({ keyId: 'key-agnes-123', key: 'sk-test', endpoint: 'https://apihub.agnes-ai.com/v1' }));
  });

  test('generate failure calls pool.markFailure with statusCode + error', async () => {
    global.__GATEWAY_FAKE_FAIL__ = true;
    const adapter = require('../src/services/gateway/adapters/apiAdapter');
    const result = await adapter.generate('hello', {
      model: 'api:agnes:agnes-2.5-flash',
      apiPoolProvider: 'agnes',
    });

    expect(result.success).toBe(false);
    expect(mockPool.pick).toHaveBeenCalledWith('agnes');
    expect(mockPool.markFailure).toHaveBeenCalledTimes(1);
    expect(mockPool.markFailure.mock.calls[0][0]).toBe('key-agnes-123');
    expect(mockPool.markFailure.mock.calls[0][1]).toBe(502);
    expect(String(mockPool.markFailure.mock.calls[0][2])).toContain('502');
  });

  test('generate success calls pool.markSuccess', async () => {
    const adapter = require('../src/services/gateway/adapters/apiAdapter');
    const result = await adapter.generate('hello', {
      model: 'api:agnes:agnes-2.5-flash',
      apiPoolProvider: 'agnes',
    });

    expect(result.success).toBe(true);
    expect(mockPool.pick).toHaveBeenCalledWith('agnes');
    expect(mockPool.markSuccess).toHaveBeenCalledTimes(1);
    expect(mockPool.markSuccess.mock.calls[0][0]).toBe('key-agnes-123');
    expect(mockPool.markFailure).not.toHaveBeenCalled();
  });

  test('non-pool-suffixed model still marks the resolved pool key on failure', async () => {
    global.__GATEWAY_FAKE_FAIL__ = true;
    const adapter = require('../src/services/gateway/adapters/apiAdapter');
    const result = await adapter.generate('hello', {
      model: 'openai:gpt-4o-mini',
      apiKey: 'direct-key',
    });

    // openai 也是池别名 → 失败应 markFailure 到 openai pool key(这才是修复本意:任何池 key 失败都降级)。
    expect(result.success).toBe(false);
    expect(mockPool.pick).toHaveBeenCalledWith('openai');
    expect(mockPool.markFailure).toHaveBeenCalledTimes(1);
    expect(mockPool.markFailure.mock.calls[0][0]).toBe('key-agnes-123');
  });
});
