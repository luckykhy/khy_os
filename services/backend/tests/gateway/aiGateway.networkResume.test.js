'use strict';

/**
 * Tests for the「断网自动续传」(network-recovery resume) feature in
 * aiGatewayGenerateMethod.js — KHY_GATEWAY_NETWORK_RESUME (default on).
 *
 * When the cascade exhausts every adapter with recoverable network-class
 * failures (at least one jitter signal, no hard-deterministic failure), the
 * request does NOT surface the「所有 AI 通道均不可用」wall immediately. Instead
 * it polls the failed channel via testAdapter and auto-re-runs the whole
 * cascade once the network comes back, bounded by
 * KHY_GATEWAY_NETWORK_RESUME_MAX_MS and the hard wall-clock deadline.
 *
 * Coverage:
 *  - recovers mid-wait and returns the answer
 *  - reports the wait honestly when the network stays down
 *  - networkResume:false keeps the wall immediate
 *  - background / internal requests never engage resume
 *  - hard-deterministic failures (auth) never engage resume
 *  - single resume cycle: recovery re-run failure reports honestly
 */

function createAdapterEntry(key, generateImpl, detectImpl) {
  const generate = jest.fn(generateImpl);
  const detect = typeof detectImpl === 'function' ? detectImpl : () => true;
  return {
    key,
    enabled: true,
    available: true,
    priority: 1,
    adapter: {
      detect: () => detect(),
      detectAsync: async (force) => detect(),
      listModels: async () => [{ id: 'm1' }],
      getStatus: () => ({ name: key, available: true }),
      generate,
    },
    _generateMock: generate,
  };
}

function netFail(key) {
  return {
    success: false,
    error: 'read ECONNRESET socket hang up',
    statusCode: 0,
    errorType: 'network',
    provider: key,
    adapter: key,
    attempts: [],
  };
}

// Keep these tests hermetic (same rationale as the cascade-jitter tests).
function neutralizeCuratedDefaultModel() {
  const modelCuration = require('../../src/services/gateway/modelCuration');
  modelCuration.getAdapterOverride = () => null;
}

function neutralizeCacheEconomyStore() {
  const cacheEconomyStore = require('../../src/services/gateway/cacheEconomyStore');
  cacheEconomyStore.getVerdict = () => 'insufficient_data';
  cacheEconomyStore.record = () => {};
}

function neutralizeApiKeyPool() {
  const apiKeyPool = require('../../src/services/apiKeyPool');
  apiKeyPool.init = () => { throw new Error('apiKeyPool disabled for hermetic resume tests'); };
}

const ENV_KEYS = [
  'GATEWAY_MAX_TOTAL_ATTEMPTS',
  'GATEWAY_MAX_RETRY_DELAY_BUDGET_MS',
  'GATEWAY_CASCADE_JITTER_RETRY_ROUNDS',
  'GATEWAY_RETRY_BUDGET_JITTER_AUTO_BOOST',
  'GATEWAY_ADAPTER_MAX_ATTEMPTS',
  'GATEWAY_PREFERRED_ADAPTER',
  'GATEWAY_PREFERRED_STRICT',
  'KHY_GATEWAY_HARD_TIMEOUT',
  'KHY_GATEWAY_MAX_TOTAL_ATTEMPTS',
  'KHY_GATEWAY_NETWORK_RESUME',
  'KHY_GATEWAY_NETWORK_RESUME_MAX_MS',
  'KHY_GATEWAY_NETWORK_RESUME_POLL_MS',
  'KHY_GATEWAY_NETWORK_RESUME_PROBE_TIMEOUT_MS',
  'KHY_GATEWAY_RESUME_MAX_CYCLES',
];

const savedEnv = {};

describe('Gateway network-recovery resume (KHY_GATEWAY_NETWORK_RESUME)', () => {
  let gateway;

  const setupGateway = () => {
    gateway = require('../../src/services/gateway/aiGateway');
    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._adapters = [];
    gateway._lastRefreshTime = Date.now();
    gateway._adapterFailures = {};
    gateway._adapterLastError = {};
    gateway._requestLog = {};
    gateway._localAdapters = new Set();
    gateway._serializedAdapterKeys = new Set();
    gateway.refreshAdapters = async () => {};
    gateway._enforceRateLimit = async () => {};
  };

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
    ENV_KEYS.forEach((k) => { delete process.env[k]; });

    // Isolate the resume feature: skip the within-request jitter rounds so the
    // request reaches the resume wait immediately, and use short resume timing.
    process.env.GATEWAY_CASCADE_JITTER_RETRY_ROUNDS = '0';
    process.env.KHY_GATEWAY_NETWORK_RESUME = '1';
    process.env.KHY_GATEWAY_NETWORK_RESUME_MAX_MS = '2500';
    process.env.KHY_GATEWAY_NETWORK_RESUME_POLL_MS = '300';
    process.env.KHY_GATEWAY_NETWORK_RESUME_PROBE_TIMEOUT_MS = '2000';
    process.env.KHY_GATEWAY_RESUME_MAX_CYCLES = '2';

    setupGateway();
    neutralizeCuratedDefaultModel();
    neutralizeCacheEconomyStore();
    neutralizeApiKeyPool();
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
    jest.restoreAllMocks();
  });

  test('recovers mid-wait and auto-resumes the cascade with a successful answer', async () => {
    const netState = { up: false };
    let aCalls = 0;
    const a = createAdapterEntry('a', async () => {
      aCalls++;
      if (aCalls === 1) return netFail('a');
      return { success: true, content: 'recovered', provider: 'a', adapter: 'a', model: 'a-1' };
    }, () => netState.up);
    const b = createAdapterEntry('b', async () => netFail('b'), () => netState.up);
    gateway._adapters = [a, b];

    setTimeout(() => { netState.up = true; }, 150);

    const statuses = [];
    const result = await gateway.generate('ping', {
      maxAdapterAttempts: 1,
      onChunk: (c) => {
        if (c && c.type === 'status') statuses.push(String(c.text || ''));
      },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('a');
    expect(a._generateMock).toHaveBeenCalledTimes(2);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
    expect(statuses.some((s) => s.includes('网络已恢复，正在自动重试全部通道'))).toBe(true);
    expect(String(result.content || '')).not.toContain('所有 AI 通道均不可用');
  }, 30000);

  test('reports the wait honestly when the network stays down', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'), () => false);
    const b = createAdapterEntry('b', async () => netFail('b'), () => false);
    gateway._adapters = [a, b];

    const result = await gateway.generate('ping', { maxAdapterAttempts: 1 });

    expect(result.success).toBe(false);
    expect(String(result.content || '')).toContain('所有 AI 通道均不可用');
    expect(String(result.content || '')).toMatch(/已等待网络恢复 \d+s 仍不可用/);
  }, 30000);

  test('networkResume: false keeps the failure wall immediate', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'), () => false);
    const b = createAdapterEntry('b', async () => netFail('b'), () => false);
    gateway._adapters = [a, b];

    const started = Date.now();
    const result = await gateway.generate('ping', { maxAdapterAttempts: 1, networkResume: false });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(String(result.content || '')).toContain('所有 AI 通道均不可用');
    expect(String(result.content || '')).not.toMatch(/已等待网络恢复/);
    expect(elapsed).toBeLessThan(2000);
  }, 30000);

  test('background requests never engage the resume wait', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'), () => false);
    gateway._adapters = [a];

    const started = Date.now();
    const result = await gateway.generate('ping', {
      maxAdapterAttempts: 1,
      requestSource: 'background',
    });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(2000);
    expect(String(result.content || '')).not.toMatch(/已等待网络恢复/);
  }, 30000);

  test('hard-deterministic failures (auth) never engage the resume wait', async () => {
    const a = createAdapterEntry('a', async () => ({
      success: false,
      error: 'invalid api key',
      statusCode: 401,
      errorType: 'auth',
      provider: 'a',
      adapter: 'a',
      attempts: [],
    }), () => false);
    const b = createAdapterEntry('b', async () => netFail('b'), () => false);
    gateway._adapters = [a, b];

    const started = Date.now();
    const result = await gateway.generate('ping', { maxAdapterAttempts: 1 });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(elapsed).toBeLessThan(2000);
    expect(String(result.content || '')).not.toMatch(/已等待网络恢复/);
  }, 30000);

  test('single resume cycle: recovery re-run failure reports honestly', async () => {
    process.env.KHY_GATEWAY_RESUME_MAX_CYCLES = '1';
    const netState = { up: false };
    const a = createAdapterEntry('a', async () => netFail('a'), () => netState.up);
    const b = createAdapterEntry('b', async () => netFail('b'), () => netState.up);
    gateway._adapters = [a, b];

    setTimeout(() => { netState.up = true; }, 150);

    const result = await gateway.generate('ping', { maxAdapterAttempts: 1 });

    expect(result.success).toBe(false);
    expect(String(result.content || '')).toContain('所有 AI 通道均不可用');
    expect(String(result.content || '')).toMatch(/已等待网络恢复并自动重试（\d+ 轮续传），重试仍未成功。/);
  }, 30000);
});
