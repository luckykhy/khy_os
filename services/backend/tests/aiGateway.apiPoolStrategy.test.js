'use strict';

jest.mock('../src/services/diagnosticEvents', () => ({
  diagnostics: {
    emitModelRequest: jest.fn(),
    emitModelResponse: jest.fn(),
  },
  generateTraceId: () => 'trace-api-pool',
}));

jest.mock('../src/services/usageTracker', () => ({
  usageTracker: { record: jest.fn() },
}));

jest.mock('../src/services/contextWindowGuard', () => ({
  evaluateGuard: jest.fn(() => ({ passed: true })),
  formatWarning: jest.fn(() => ''),
}));

jest.mock('../src/services/aiMonitor', () => ({
  startTrace: jest.fn(() => 'trace-1'),
  endTrace: jest.fn(),
  addCascadeAttempt: jest.fn(),
}));

jest.mock('../src/services/liveModelSwitch', () => ({
  getInstance: () => ({
    getActiveModel: () => null,
    generationStarted: jest.fn(),
    generationCompleted: jest.fn(),
  }),
}));

jest.mock('../src/services/advancedDiagnostics', () => ({
  getInstance: () => ({
    recordLatency: jest.fn(),
    recordError: jest.fn(),
  }),
}));

jest.mock('../src/services/usageHabitService', () => ({
  getPreferredModel: jest.fn(() => null),
  recordModelUsage: jest.fn(),
  recordInteraction: jest.fn(),
}));

jest.mock('../src/services/gateway/pluginChain', () => ({
  executeBeforeRequest: jest.fn(async (ctx) => ctx),
  executeAfterResponse: jest.fn(async (ctx) => ctx),
}));

const mockPool = {
  init: jest.fn(),
  hasAvailableKeys: jest.fn(() => true),
  listAvailableKeys: jest.fn(() => ([
    { keyId: 'k1', key: 'sk-key-1', endpoint: 'https://pool-1.example/v1', label: 'k1', priority: 0, totalRequests: 10, totalFailures: 4, backoffLevel: 0 },
    { keyId: 'k2', key: 'sk-key-2', endpoint: 'https://pool-2.example/v1', label: 'k2', priority: 0, totalRequests: 1, totalFailures: 0, backoffLevel: 0 },
  ])),
  pickById: jest.fn((provider, keyId) => {
    const row = keyId === 'k2'
      ? { keyId: 'k2', key: 'sk-key-2', endpoint: 'https://pool-2.example/v1', label: 'k2' }
      : { keyId: 'k1', key: 'sk-key-1', endpoint: 'https://pool-1.example/v1', label: 'k1' };
    return row;
  }),
  pick: jest.fn(() => ({ keyId: 'k1', key: 'sk-key-1', endpoint: 'https://pool-1.example/v1', label: 'k1' })),
  markSuccess: jest.fn(),
  markFailure: jest.fn(),
};

jest.mock('../src/services/apiKeyPool', () => mockPool);

jest.mock('../src/services/concurrencySlots', () => ({
  acquire: jest.fn(() => jest.fn()),
}));

jest.mock('../src/services/gateway/keySelector', () => ({
  resolveStrategy: jest.fn(() => 'least-used'),
  selectCandidate: jest.fn((candidates) => candidates.find(c => c.keyId === 'k2') || candidates[0] || null),
}));

describe('aiGateway api pool strategy', () => {
  let gateway = null;

  beforeEach(() => {
    jest.resetModules();
    gateway = require('../src/services/gateway/aiGateway');
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.GATEWAY_POOL_MAX_RETRIES;
    delete process.env.GATEWAY_API_POOL_PROVIDER;
  });

  function buildGatewayWithApiAdapter(adapterGenerate) {
    const gw = Object.create(gateway);
    const mockAdapter = {
      detect: jest.fn(() => true),
      getStatus: jest.fn(() => ({
        name: 'API 云端服务',
        type: 'api',
        available: true,
      })),
      generate: jest.fn(adapterGenerate),
      listModels: jest.fn(async () => []),
      destroy: jest.fn(),
    };

    gw._initialized = true;
    gw._adapters = [
      { key: 'api', adapter: mockAdapter, priority: 0, enabled: true, available: true },
    ];
    gw._adapterFailures = {};
    gw._adapterLastError = {};
    gw._requestLog = {};
    gw._localAdapters = new Set();
    gw._serializedAdapterKeys = new Set();
    gw._adapterQueue = (key, fn) => fn();
    gw._keyedLimiter = { consume: () => ({ allowed: true }) };
    gw._lastRefreshTime = Date.now();

    gw._enforceRateLimit = async () => {};
    gw._generateWithAdapterIsolation = gateway._generateWithAdapterIsolation.bind(gw);
    gw._getRecentFastFail = () => null;
    gw._clearAdapterFailure = () => {};
    gw._recordAdapterFailure = () => {};
    gw._shouldSerializeAdapter = () => false;
    gw.refreshAdapters = async () => {};
    return { gw, mockAdapter };
  }

  test('uses key selector result for api adapter pool request', async () => {
    const { gw, mockAdapter } = buildGatewayWithApiAdapter(async (prompt, options) => ({
      success: true,
      content: 'ok',
      provider: options.provider || 'api',
      adapter: 'api',
      model: options.model || null,
    }));

    const result = await gateway.generate.call(gw, 'hello', {
      model: 'openai:gpt-4o-mini',
    });

    expect(result.success).toBe(true);
    expect(mockPool.listAvailableKeys).toHaveBeenCalledWith('openai');
    expect(mockPool.pickById).toHaveBeenCalledWith('openai', 'k2');
    expect(mockPool.markSuccess).toHaveBeenCalledWith('k2');

    expect(mockAdapter.generate).toHaveBeenCalledTimes(1);
    const [, opts] = mockAdapter.generate.mock.calls[0];
    expect(opts.apiKey).toBe('sk-key-2');
    expect(opts.apiEndpoint).toBe('https://pool-2.example/v1');
    expect(opts.provider).toBe('openai');
    expect(opts.apiPoolProvider).toBe('openai');
  });

  test('infers pool provider and default model from apiPoolProvider hint', async () => {
    const { gw, mockAdapter } = buildGatewayWithApiAdapter(async (prompt, options) => ({
      success: true,
      content: 'ok',
      provider: options.provider || 'api',
      adapter: 'api',
      model: options.model || null,
    }));

    const result = await gateway.generate.call(gw, 'hello', {
      apiPoolProvider: 'deepseek',
    });

    expect(result.success).toBe(true);
    expect(mockPool.listAvailableKeys).toHaveBeenCalledWith('deepseek');
    const [, opts] = mockAdapter.generate.mock.calls[0];
    expect(opts.provider).toBe('openai');
    expect(opts.apiPoolProvider).toBe('deepseek');
    expect(opts.model).toBe('deepseek-chat');
  });

  test('supports relay pool provider via openai-compatible api path', async () => {
    const { gw, mockAdapter } = buildGatewayWithApiAdapter(async (prompt, options) => ({
      success: true,
      content: 'ok',
      provider: options.provider || 'api',
      adapter: 'api',
      model: options.model || null,
    }));

    const result = await gateway.generate.call(gw, 'hello', {
      apiPoolProvider: 'relay',
    });

    expect(result.success).toBe(true);
    expect(mockPool.listAvailableKeys).toHaveBeenCalledWith('relay');
    const [, opts] = mockAdapter.generate.mock.calls[0];
    expect(opts.provider).toBe('openai');
    expect(opts.apiPoolProvider).toBe('relay');
    expect(opts.model).toBe('gpt-4o-mini');
  });
});
