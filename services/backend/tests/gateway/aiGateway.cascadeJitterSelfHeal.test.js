'use strict';

/**
 * Tests for the transient network-jitter whole-cascade self-heal rounds
 * (GATEWAY_CASCADE_JITTER_RETRY_ROUNDS, default 3) in aiGatewayGenerateMethod.js.
 *
 * When the cascade exhausts every adapter and ALL real attempts failed with
 * transient (network-jitter-classified) errors, the gateway waits with backoff,
 * clears the transient fast-fail caches of the failed channels, and re-runs the
 * whole cascade for up to `cascadeJitterRounds` extra rounds — instead of
 * surfacing the「所有 AI 通道均不可用」wall after a single pass.
 *
 * Deterministic failures (model_not_found / auth / bad_request) never trigger
 * the rounds; setting `cascadeJitterRounds: 0` (or env off) restores the
 * legacy single-pass behavior.
 */

function createAdapterEntry(key, generateImpl, options = {}) {
  const {
    available = true,
    enabled = true,
    detail = 'ok',
  } = options;

  const generate = jest.fn(generateImpl);
  return {
    key,
    enabled,
    available,
    priority: 1,
    adapter: {
      detect: () => available,
      getStatus: () => ({ name: key, available, detail }),
      generate,
    },
    _generateMock: generate,
  };
}

// Keep these tests hermetic: at request time the gateway's default-model
// fallback reads the user's real .khy/model_overrides.json via
// modelCuration.getAdapterOverride('api'); stub the curation lookup on the
// CURRENT module instance (must be re-applied after jest.resetModules()).
function neutralizeCuratedDefaultModel() {
  const modelCuration = require('../../src/services/gateway/modelCuration');
  modelCuration.getAdapterOverride = () => null;
}

// Keep default-route ranking hermetic: _assessDefaultRouteCandidate consults
// cacheEconomyStore.getVerdict() backed by the user's real store. Also stub
// record() so test adapters never pollute it.
function neutralizeCacheEconomyStore() {
  const cacheEconomyStore = require('../../src/services/gateway/cacheEconomyStore');
  cacheEconomyStore.getVerdict = () => 'insufficient_data';
  cacheEconomyStore.record = () => {};
}

// Keep the 'api' adapter off the pool-based branch (see aiGateway.retryBudget
// test for the rationale) so unknown test keys use the standard single-key flow.
function neutralizeApiKeyPool() {
  const apiKeyPool = require('../../src/services/apiKeyPool');
  apiKeyPool.init = () => { throw new Error('apiKeyPool disabled for hermetic jitter-round tests'); };
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
];

const savedEnv = {};

describe('Gateway transient network-jitter whole-cascade self-heal', () => {
  let gateway;

  const netFail = (key) => ({
    success: false,
    error: 'read ECONNRESET socket hang up',
    statusCode: 0,
    errorType: 'network',
    provider: key,
    adapter: key,
    attempts: [],
  });

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    ENV_KEYS.forEach((k) => { savedEnv[k] = process.env[k]; });
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
    // These tests exercise the within-request jitter self-heal rounds in
    // isolation; the network-resume wait (KHY_GATEWAY_NETWORK_RESUME) is tested
    // separately in aiGateway.networkResume.test.js, so keep it off here.
    process.env.KHY_GATEWAY_NETWORK_RESUME = '0';

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

  test('re-runs whole cascade and recovers when a channel recovers mid-jitter', async () => {
    let aCalls = 0;
    const a = createAdapterEntry('a', async () => {
      aCalls++;
      if (aCalls === 1) return netFail('a');
      return { success: true, content: 'recovered', provider: 'a', adapter: 'a', model: 'a-1' };
    });
    const b = createAdapterEntry('b', async () => netFail('b'));
    gateway._adapters = [a, b];

    const statuses = [];
    const result = await gateway.generate('ping', {
      maxAdapterAttempts: 1,
      onChunk: (c) => {
        if (c && c.type === 'status') statuses.push(String(c.text || ''));
      },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('a');
    // Round 1 failed a+b, round 2 retried a (recovered) — b never retried.
    expect(a._generateMock).toHaveBeenCalledTimes(2);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
    expect(statuses.some((s) => s.includes('整轮自愈重试'))).toBe(true);
    expect(String(result.content || '')).not.toContain('所有 AI 通道均不可用');
  }, 30000);

  test('bounds extra rounds and reports self-heal in the failure wall', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'));
    const b = createAdapterEntry('b', async () => netFail('b'));
    gateway._adapters = [a, b];

    const result = await gateway.generate('ping', {
      maxAdapterAttempts: 1,
      cascadeJitterRounds: 2,
    });

    expect(result.success).toBe(false);
    // Initial pass + 2 self-heal rounds = 3 full passes.
    expect(a._generateMock).toHaveBeenCalledTimes(3);
    expect(b._generateMock).toHaveBeenCalledTimes(3);
    expect(String(result.content || '')).toContain('已自动执行 2/2 轮网络抖动整轮自愈重试');
    expect(String(result.content || '')).toContain('所有 AI 通道均不可用');
  }, 20000);

  test('does not re-run rounds when failures are deterministic (model_not_found)', async () => {
    const a = createAdapterEntry('a', async () => ({
      success: false,
      error: 'model not found',
      statusCode: 404,
      errorType: 'model_not_found',
      provider: 'a',
      adapter: 'a',
    }));
    const b = createAdapterEntry('b', async () => ({
      success: false,
      error: 'model not found',
      statusCode: 404,
      errorType: 'model_not_found',
      provider: 'b',
      adapter: 'b',
    }));
    gateway._adapters = [a, b];

    const result = await gateway.generate('ping', { maxAdapterAttempts: 1 });

    expect(result.success).toBe(false);
    expect(a._generateMock).toHaveBeenCalledTimes(1);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
    expect(String(result.content || '')).not.toContain('整轮自愈重试');
  }, 30000);

  test('skips rounds when any real failure is deterministic (mixed)', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'));
    const b = createAdapterEntry('b', async () => ({
      success: false,
      error: 'invalid api key',
      statusCode: 401,
      errorType: 'auth',
      provider: 'b',
      adapter: 'b',
    }));
    gateway._adapters = [a, b];

    const result = await gateway.generate('ping', { maxAdapterAttempts: 1 });

    expect(result.success).toBe(false);
    expect(a._generateMock).toHaveBeenCalledTimes(1);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
  }, 30000);

  test('cascadeJitterRounds: 0 restores legacy single-pass behavior', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'));
    const b = createAdapterEntry('b', async () => netFail('b'));
    gateway._adapters = [a, b];

    const result = await gateway.generate('ping', {
      maxAdapterAttempts: 1,
      cascadeJitterRounds: 0,
    });

    expect(result.success).toBe(false);
    expect(a._generateMock).toHaveBeenCalledTimes(1);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
    expect(String(result.content || '')).not.toContain('整轮自愈重试');
  }, 30000);

  test('env GATEWAY_CASCADE_JITTER_RETRY_ROUNDS=0 disables rounds', async () => {
    process.env.GATEWAY_CASCADE_JITTER_RETRY_ROUNDS = '0';
    jest.resetModules();
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
    neutralizeCuratedDefaultModel();
    neutralizeCacheEconomyStore();
    neutralizeApiKeyPool();

    const a = createAdapterEntry('a', async () => netFail('a'));
    const b = createAdapterEntry('b', async () => netFail('b'));
    gateway._adapters = [a, b];

    const result = await gateway.generate('ping', { maxAdapterAttempts: 1 });

    expect(result.success).toBe(false);
    expect(a._generateMock).toHaveBeenCalledTimes(1);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
  }, 30000);

  test('does not self-heal while the request was aborted', async () => {
    const a = createAdapterEntry('a', async () => netFail('a'));
    const b = createAdapterEntry('b', async () => netFail('b'));
    gateway._adapters = [a, b];

    const ac = new AbortController();
    ac.abort();
    const result = await gateway.generate('ping', {
      maxAdapterAttempts: 1,
      abortSignal: ac.signal,
      cascadeJitterRounds: 3,
    });

    expect(result.success).toBe(false);
    expect(a._generateMock).toHaveBeenCalledTimes(0);
    expect(b._generateMock).toHaveBeenCalledTimes(0);
  }, 30000);
});
