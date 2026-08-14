'use strict';

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
// modelCuration.getAdapterOverride('api'); when the user has configured an
// api defaultModel (e.g. 'api:sensenova:...'), the 'api' adapter is routed
// into the pool-based multi-key branch instead of the standard single-key
// flow, changing the retry semantics under test. Stub the curation lookup on
// the CURRENT module instance (must be re-applied after jest.resetModules()).
function neutralizeCuratedDefaultModel() {
  const modelCuration = require('../src/services/gateway/modelCuration');
  modelCuration.getAdapterOverride = () => null;
}

// Keep default-route ranking hermetic: _assessDefaultRouteCandidate consults
// require('./cacheEconomyStore').getVerdict(adapterKey), which is backed by the
// user's real .khy/gateway/cache_economy.json. Earlier test runs left entries
// there (e.g. adapter 'b' flagged as cache-opaque), adding a route penalty that
// demotes 'b' below 'c' and breaks the a -> b -> c cascade order these tests
// assume. Also stub record() so test adapters never pollute the real store
// again. Must be re-applied after jest.resetModules().
function neutralizeCacheEconomyStore() {
  const cacheEconomyStore = require('../src/services/gateway/cacheEconomyStore');
  cacheEconomyStore.getVerdict = () => 'insufficient_data';
  cacheEconomyStore.record = () => {};
}

// Keep the 'api' adapter on the standard single-key flow: the gateway's pool
// integration (`const pool = require('../apiKeyPool'); pool.init();`) reads the
// user's real .khy/api_keys.json; with live keys (plus a wildcard
// GATEWAY_API_POOL_PROVIDER) the 'api' adapter is hijacked into the pool-based
// multi-key branch, whose per-key failure semantics bypass the retry-delay
// budget under test. Throwing from init() lands in the branch's own fail-soft
// catch ("pool not available, fall through to normal flow"), i.e. the exact
// pre-pool standard flow. Must be re-applied after jest.resetModules().
function neutralizeApiKeyPool() {
  const apiKeyPool = require('../src/services/apiKeyPool');
  apiKeyPool.init = () => { throw new Error('apiKeyPool disabled for hermetic retry-budget tests'); };
}

describe('aiGateway retry budget guard', () => {
  let gateway;
  let oldMaxAttempts;
  let oldRetryDelayBudgetMs;
  let oldPoolRetries;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    gateway = require('../src/services/gateway/aiGateway');
    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._adapters = [];
    gateway._lastRefreshTime = Date.now();
    gateway.refreshAdapters = async () => {};
    gateway._enforceRateLimit = async () => {};
    neutralizeCuratedDefaultModel();
    neutralizeCacheEconomyStore();
    neutralizeApiKeyPool();

    oldMaxAttempts = process.env.GATEWAY_MAX_TOTAL_ATTEMPTS;
    oldRetryDelayBudgetMs = process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS;
    oldPoolRetries = process.env.GATEWAY_POOL_MAX_RETRIES;
    delete process.env.GATEWAY_MAX_TOTAL_ATTEMPTS;
    delete process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS;
    delete process.env.GATEWAY_POOL_MAX_RETRIES;
  });

  afterEach(() => {
    if (oldMaxAttempts === undefined) delete process.env.GATEWAY_MAX_TOTAL_ATTEMPTS;
    else process.env.GATEWAY_MAX_TOTAL_ATTEMPTS = oldMaxAttempts;
    if (oldRetryDelayBudgetMs === undefined) delete process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS;
    else process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS = oldRetryDelayBudgetMs;
    if (oldPoolRetries === undefined) delete process.env.GATEWAY_POOL_MAX_RETRIES;
    else process.env.GATEWAY_POOL_MAX_RETRIES = oldPoolRetries;
    jest.restoreAllMocks();
  });

  // NOTE (anti-jitter supersession): these tests exercise the *numeric* retry-budget
  // guard (GATEWAY_MAX_TOTAL_ATTEMPTS / GATEWAY_MAX_RETRY_DELAY_BUDGET_MS) in isolation.
  // They originally drove the guard with HTTP 503/504. Those status codes are now
  // deliberately classified as *network-jitter* failures (_isNetworkJitterLikeFailure):
  //   1) they trigger the jitter auto-boost which EXPANDS the budget (2 -> 5), so the
  //      guard no longer trips at the configured ceiling, and
  //   2) they are cooldown-cached, so a single repeatedly-failing adapter is fast-failed
  //      to one real call + a virtual skip instead of looping.
  // Both are intentional coherence/anti-jitter behaviors. To test the guard itself we use
  // a generic retryable server error (HTTP 500, errorType 'server_error') — retryable but
  // neither jitter-classified nor cooldown-cached — and disable the jitter auto-boost so
  // the guard is the binding constraint. The guard's production code is unchanged.
  // The total-attempt budget is a *cross-adapter global* counter. Driving it with a single
  // repeatedly-failing adapter races the per-adapter cooldown cache (which fast-fails the
  // 3rd inner attempt via a virtual skip and breaks the loop before the global guard trips).
  // A multi-adapter cascade with one attempt each isolates the global counter: adapter `a`
  // reserves attempt 1, adapter `b` reserves attempt 2, adapter `c` would be attempt 3 (> 2)
  // and is refused — so `c` is never called and the run fails as retry_budget_exceeded.
  test('fails fast when total-attempt budget is exceeded', async () => {
    process.env.GATEWAY_MAX_TOTAL_ATTEMPTS = '2';

    const mkServerError = (key) => createAdapterEntry(key, async () => ({
      success: false,
      error: `temporary server error ${key}`,
      statusCode: 500,
      errorType: 'server_error',
      provider: key,
      adapter: key,
    }));
    const a = mkServerError('a');
    const b = mkServerError('b');
    const c = mkServerError('c');
    gateway._adapters = [a, b, c];

    const result = await gateway.generate('budget-attempts-test', {
      maxAdapterAttempts: 1,
      retryBudgetJitterAutoBoost: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('retry_budget_exceeded');
    expect(String(result.content || '')).toContain('请求重试预算已用尽');
    expect(a._generateMock).toHaveBeenCalledTimes(1);
    expect(b._generateMock).toHaveBeenCalledTimes(1);
    expect(c._generateMock).not.toHaveBeenCalled();
  });

  test('fails fast when retry-delay budget is exceeded', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS = '1200';

    const apiEntry = createAdapterEntry('api', async () => ({
      success: false,
      error: 'temporary server error',
      statusCode: 500,
      errorType: 'server_error',
      provider: 'api',
      adapter: 'api',
    }));
    gateway._adapters = [apiEntry];

    const result = await gateway.generate('budget-delay-test', {
      maxAdapterAttempts: 5,
      retryBudgetJitterAutoBoost: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('retry_budget_exceeded');
    expect(String(result.content || '')).toContain('重试等待预算超限');
    expect(apiEntry._generateMock).toHaveBeenCalledTimes(2);
  });
});
