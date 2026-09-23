/**
 * aiGateway.credentialRefreshRetry.test.js — locks the "C: auto credential
 * refresh" gap branches in src/services/gateway/aiGatewayGenerateMethod.js:
 *
 *   - thrown 401/403 (errorType 'auth') on an adapter that exposes an optional
 *     refreshCredential() → the gateway funnels it through the single-flight
 *     credentialRefreshCoordinator ONCE per request per adapter; a successful
 *     refresh clears the just-recorded fast-fail entry and retries the SAME
 *     channel (no key-pool rotation, no cascade).
 *   - refresh failure / adapter without refreshCredential / KHY_AUTO_CREDENTIAL_REFRESH
 *     gate off → refresh is skipped (at most one attempt) and the request
 *     degrades to the account-pool auth handler (_handleAccountPoolAuthError),
 *     then to the honest failed result — never a hang, never a second refresh.
 *
 * Same hermetic harness as tests/aiGateway.stability.test.js: Object.create()
 * over the gateway singleton (inheriting real _dedup/_keyedLimiter) with a
 * counting fake adapter and stubbed host auth handler. If the refresh-success
 * retry-once / fail-fallback contract drifts, this suite goes red.
 */

'use strict';

jest.mock('../src/services/diagnosticEvents', () => ({
  diagnostics: {
    emitModelRequest: jest.fn(),
    emitModelResponse: jest.fn(),
  },
  generateTraceId: () => 'test-trace-id',
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

jest.mock('../src/services/apiKeyPool', () => ({
  init: jest.fn(),
  hasAvailableKeys: jest.fn(() => false),
}));

jest.mock('../src/services/concurrencySlots', () => ({
  acquire: jest.fn(() => jest.fn()),
}));

jest.mock('../src/services/gateway/pluginChain', () => ({
  executeBeforeRequest: jest.fn(async (ctx) => ctx),
  executeAfterResponse: jest.fn(async (ctx) => ctx),
}));

const AI_GATEWAY_MODULE_PATH = require.resolve('../src/services/gateway/aiGateway');

async function cleanupGatewaySingleton() {
  const cached = require.cache[AI_GATEWAY_MODULE_PATH];
  const gateway = cached && cached.exports;
  if (gateway && typeof gateway.destroy === 'function') {
    try {
      await gateway.destroy();
    } catch {
      /* best-effort */
    }
  }
  delete require.cache[AI_GATEWAY_MODULE_PATH];
}

/** Fake adapter that throws an HTTP-status error on the first N calls. */
function createAuthAdapter(name, { failTimes, refreshResult, withRefresher = true } = {}) {
  let calls = 0;
  const generate = jest.fn(async () => {
    calls += 1;
    if (calls <= failTimes) {
      const err = new Error(`${name} API key invalid or expired (401)`);
      err.status = 401;
      throw err;
    }
    return {
      success: true,
      content: `ok from ${name} after ${calls - 1} refresh(es)`,
      provider: name,
      adapter: name.toLowerCase(),
      model: 'test-model',
    };
  });
  const adapter = {
    name,
    key: name.toLowerCase(),
    detect: jest.fn(() => true),
    generate,
    getStatus: jest.fn(() => ({ name, type: 'test', available: true, activeModel: null })),
    listModels: jest.fn(async () => []),
    destroy: jest.fn(),
  };
  if (withRefresher) {
    adapter.refreshCredential = jest.fn(async () => refreshResult);
  }
  return { adapter, generate };
}

function makeFakeGateway(adapter, key) {
  const AIGateway = require(AI_GATEWAY_MODULE_PATH);
  const gw = Object.create(AIGateway);
  gw._adapters = [{ key, adapter, priority: 0, enabled: true, available: true }];
  gw._initialized = true;
  gw._adapterFailures = {};
  gw._adapterLastError = {};
  gw._requestLog = {};
  gw._localAdapters = new Set();
  gw._serializedAdapterKeys = new Set();
  gw._adapterQueue = (k, fn) => fn();
  gw._keyedLimiter = { consume: () => ({ allowed: true }) };
  gw._lastRefreshTime = Date.now();
  gw._enforceRateLimit = async () => {};
  gw._generateWithAdapterIsolation = async (entry, prompt, opts) =>
    entry.adapter.generate(prompt, opts);
  gw._getRecentFastFail = () => null;
  gw._clearAdapterFailure = jest.fn((k) => {
    delete gw._adapterLastError[k];
  });
  gw._recordAdapterFailure = jest.fn(async () => {});
  gw._shouldSerializeAdapter = () => false;
  gw._handleAccountPoolAuthError = jest.fn(async () => {});
  gw.refreshAdapters = async () => {};
  return gw;
}

describe('auto credential refresh on auth failure (generate gap branches)', () => {
  afterEach(async () => {
    await cleanupGatewaySingleton();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupGatewaySingleton();
  });

  test('401 + refreshCredential 成功 → 原通道重试一次并成功（不走密钥池轮转）', async () => {
    const { adapter } = createAuthAdapter('AuthX', {
      failTimes: 1,
      refreshResult: { token: 'fresh-key' },
    });
    const gw = makeFakeGateway(adapter, 'authx');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);

    const result = await AIGateway.generate.call(gw, 'credential refresh success case', {
      maxAdapterAttempts: 2, // the refresh-retry consumes the regular attempt budget — a small-task run
      // would default to a single attempt and never leave room for the same-channel retry.
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('ok from AuthX after 1 refresh(es)');
    expect(adapter.generate).toHaveBeenCalledTimes(2, '401 then one same-channel retry');
    expect(adapter.refreshCredential).toHaveBeenCalledTimes(1, 'single-flight: at most one refresh per adapter per request');
    expect(gw._clearAdapterFailure).toHaveBeenCalledWith('authx'); // a successful refresh re-arms the just-cooled channel
    // 刷新成功路径必须停在原通道：不触碰账号池鉴权兜底
    expect(gw._handleAccountPoolAuthError).not.toHaveBeenCalled();
    expect(result.adapter).toBe('authx');
  });

  test('401 + refreshCredential 返回 null → 回落账号池兜底，最终诚实失败（不挂起、不二次刷新）', async () => {
    const { adapter } = createAuthAdapter('AuthY', {
      failTimes: 99, // every attempt fails with 401
      refreshResult: null,
    });
    const gw = makeFakeGateway(adapter, 'authy');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);

    const result = await AIGateway.generate.call(gw, 'credential refresh failure case', {});

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('auth');
    expect(adapter.refreshCredential).toHaveBeenCalledTimes(1, 'the failed refresh is NOT retried in the same request');
    expect(gw._handleAccountPoolAuthError).toHaveBeenCalled();
    expect(gw._handleAccountPoolAuthError.mock.calls[0][0]).toBe('authy');
    // honest failure message, not a silent success
    expect(result.content).toBeTruthy();
    expect(Array.isArray(result.attempts)).toBe(true);
  });

  test('适配器无 refreshCapability → 跳过刷新直接走账号池兜底（不抛、不挂起）', async () => {
    const { adapter } = createAuthAdapter('NoRefresh', {
      failTimes: 99,
      withRefresher: false,
    });
    const gw = makeFakeGateway(adapter, 'norefresh');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);

    const result = await AIGateway.generate.call(gw, 'no refresher case', {});

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('auth');
    expect(adapter).not.toHaveProperty('refreshCredential');
    expect(gw._handleAccountPoolAuthError).toHaveBeenCalledWith(
      'norefresh',
      'auth',
      expect.stringMatching(/401/),
      expect.any(Function)
    );
  });

  test('KHY_AUTO_CREDENTIAL_REFRESH=false → 有 refreshCapability 也绝不调用（门控逐字节回退）', async () => {
    const { adapter } = createAuthAdapter('GatedOff', {
      failTimes: 99,
      refreshResult: { token: 'should-never-be-used' },
    });
    const gw = makeFakeGateway(adapter, 'gatedoff');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);
    const saved = process.env.KHY_AUTO_CREDENTIAL_REFRESH;
    process.env.KHY_AUTO_CREDENTIAL_REFRESH = 'false';
    try {
      const result = await AIGateway.generate.call(gw, 'gate off case', {});
      expect(result.success).toBe(false);
      expect(adapter.refreshCredential).not.toHaveBeenCalled();
      expect(gw._handleAccountPoolAuthError).toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.KHY_AUTO_CREDENTIAL_REFRESH;
      else process.env.KHY_AUTO_CREDENTIAL_REFRESH = saved;
    }
  });
});
