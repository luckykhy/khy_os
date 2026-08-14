'use strict';

/**
 * Integration tests for the three gateway retry/recovery enhancements:
 *   A. Reactive Context Overflow (maxTokens adjustment)
 *   B. requestSource classification (background fast-fail)
 *   C. 401 Credential Auto-Refresh
 *
 * Uses the same mock-adapter pattern as aiGateway.retryBudget.test.js.
 * Uses preferredAdapter to control which adapter is tried first.
 */

function createAdapterEntry(key, generateImpl, options = {}) {
  const {
    available = true,
    enabled = true,
    detail = 'ok',
    refreshCredential,
  } = options;

  const generate = jest.fn(generateImpl);
  const entry = {
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
  if (refreshCredential) {
    entry.adapter.refreshCredential = jest.fn(refreshCredential);
  }
  return entry;
}

// Keep these tests hermetic: at request time the gateway's default-model
// fallback reads the user's real .khy/model_overrides.json via
// modelCuration.getAdapterOverride('api'); when the user has configured an
// api defaultModel (e.g. 'api:sensenova:...'), the 'api' adapter is routed
// into the pool-based multi-key branch instead of the standard single-key
// flow, changing the retry semantics under test. Stub the curation lookup on
// the CURRENT module instance (must be re-applied after jest.resetModules()).
function neutralizeCuratedDefaultModel() {
  const modelCuration = require('../../src/services/gateway/modelCuration');
  modelCuration.getAdapterOverride = () => null;
}

// Keep these tests hermetic on the write side too: the gateway records every
// adapter attempt into the real .khy/gateway/cache_economy.json via
// cacheEconomyStore.record(); without this stub, test adapter keys (e.g.
// 'fallback') would leak into the user's persistent store on every run.
// Must be re-applied after jest.resetModules().
function neutralizeCacheEconomyStore() {
  const cacheEconomyStore = require('../../src/services/gateway/cacheEconomyStore');
  cacheEconomyStore.record = () => {};
}

// Env keys used by the three enhancements
const ENV_KEYS = [
  'KHY_CONTEXT_OVERFLOW_AUTO_ADJUST',
  'KHY_CONTEXT_SAFETY_BUFFER_TOKENS',
  'KHY_CONTEXT_MIN_COMPLETION_TOKENS',
  'KHY_BG_FAST_FAIL',
  'KHY_AUTO_CREDENTIAL_REFRESH',
  'KHY_CREDENTIAL_REFRESH_TIMEOUT_MS',
  'GATEWAY_MAX_TOTAL_ATTEMPTS',
  'GATEWAY_MAX_RETRY_DELAY_BUDGET_MS',
  'GATEWAY_POOL_MAX_RETRIES',
  'GATEWAY_PREFERRED_ADAPTER',
  'GATEWAY_PREFERRED_STRICT',
];

const savedEnv = {};

describe('Gateway retry/recovery enhancements integration', () => {
  let gateway;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    // Save env
    ENV_KEYS.forEach(k => { savedEnv[k] = process.env[k]; });
    // Clear env for deterministic tests
    ENV_KEYS.forEach(k => { delete process.env[k]; });

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
  });

  afterEach(() => {
    // Restore env
    ENV_KEYS.forEach(k => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
    jest.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // A. Context Overflow Auto-Adjust
  // ═══════════════════════════════════════════════════════════════════════════

  describe('A: Context Overflow Auto-Adjust', () => {
    test('413/context_length with parseable tokens → adjusts maxTokens and retries successfully', async () => {
      let attempt = 0;
      const entry = createAdapterEntry('api', async () => {
        attempt++;
        if (attempt === 1) {
          return {
            success: false,
            // prompt < limit so there's room for adjustment (limit - prompt - 512 buffer >= 256 min)
            error: 'prompt is too long: 100000 tokens > 128000 maximum',
            statusCode: 413,
            errorType: 'context_length',
            provider: 'api',
            adapter: 'api',
          };
        }
        return {
          success: true,
          content: 'ok',
          provider: 'api',
          adapter: 'api',
          model: 'test-model',
        };
      });
      gateway._adapters = [entry];

      const result = await gateway.generate('test prompt', {
        preferredAdapter: 'api',
        preferredStrict: false,
        maxAdapterAttempts: 3,
      });

      expect(result.success).toBe(true);
      expect(entry._generateMock).toHaveBeenCalledTimes(2);
    });

    test('at most 1 adjustment per request (second 413 does not loop infinitely)', async () => {
      let attempt = 0;
      const entry = createAdapterEntry('api', async () => {
        attempt++;
        return {
          success: false,
          error: 'prompt is too long: 100000 tokens > 128000 maximum',
          statusCode: 413,
          errorType: 'context_length',
          provider: 'api',
          adapter: 'api',
        };
      });
      gateway._adapters = [entry];

      const result = await gateway.generate('test prompt', {
        preferredAdapter: 'api',
        preferredStrict: false,
        maxAdapterAttempts: 3,
        retryBudgetJitterAutoBoost: false,
      });

      expect(result.success).toBe(false);
      // Should have been called for: initial attempt + 1 adjustment retry + remaining
      // but NOT infinitely (max 1 adjustment means at most +1 extra call from overflow)
      expect(attempt).toBeLessThanOrEqual(5);
    });

    test('env KHY_CONTEXT_OVERFLOW_AUTO_ADJUST=0 disables adjustment', async () => {
      process.env.KHY_CONTEXT_OVERFLOW_AUTO_ADJUST = '0';
      jest.resetModules();
      gateway = require('../../src/services/gateway/aiGateway');
      gateway._initialized = true;
      gateway._initPromise = null;
      gateway._adapters = [];
      gateway._lastRefreshTime = Date.now();
      gateway.refreshAdapters = async () => {};
      gateway._enforceRateLimit = async () => {};
      neutralizeCuratedDefaultModel();
      neutralizeCacheEconomyStore();

      let attempt = 0;
      const entry = createAdapterEntry('api', async () => {
        attempt++;
        if (attempt === 1) {
          return {
            success: false,
            error: 'prompt is too long: 130000 tokens > 128000 maximum',
            statusCode: 413,
            errorType: 'context_length',
            provider: 'api',
            adapter: 'api',
          };
        }
        return { success: true, content: 'ok', provider: 'api', adapter: 'api' };
      });
      gateway._adapters = [entry];

      const result = await gateway.generate('test', {
        preferredAdapter: 'api',
        preferredStrict: false,
        maxAdapterAttempts: 1,
      });

      // With adjustment disabled, should fail on first 413 (no auto-retry)
      expect(result.success).toBe(false);
      expect(attempt).toBe(1);
    });

    test('diagnostics.contextOverflowTokens attached when available window too small', async () => {
      // When limit - prompt - buffer < minCompletion, no adjustment happens
      // but tokenInfo is still attached to diagnostics
      const entry = createAdapterEntry('api', async () => ({
        success: false,
        // prompt nearly equals limit (128000 - 127800 = 200, which < 256 default min)
        error: 'prompt is too long: 127800 tokens > 128000 maximum',
        statusCode: 413,
        errorType: 'context_length',
        provider: 'api',
        adapter: 'api',
      }));
      gateway._adapters = [entry];

      const result = await gateway.generate('test', {
        preferredAdapter: 'api',
        // preferredStrict: true routes the failure through the strict preferred
        // exit, which is the result path that propagates result.diagnostics
        // (the generic "all adapters failed" wall does not carry diagnostics).
        preferredStrict: true,
        maxAdapterAttempts: 1,
      });

      expect(result.success).toBe(false);
      // Token info should be parseable even if adjustment isn't viable
      expect(result.diagnostics).toBeTruthy();
      expect(result.diagnostics.contextOverflowTokens).toEqual({
        promptTokens: 127800,
        limitTokens: 128000,
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // B. requestSource Classification & Background Fast-Fail
  // ═══════════════════════════════════════════════════════════════════════════

  describe('B: requestSource classification & background fast-fail', () => {
    test('background + overloaded thrown error → skips same-adapter retry', async () => {
      // Use thrown errors since the thrown path (L3708-3717) has clear background fast-fail
      let attempt = 0;
      const entry = createAdapterEntry('api', async () => {
        attempt++;
        if (attempt <= 2) {
          const err = new Error('overloaded');
          err.status = 529;
          err.statusCode = 529;
          throw err;
        }
        return { success: true, content: 'ok', provider: 'api', adapter: 'api' };
      });
      gateway._adapters = [entry];

      const result = await gateway.generate('test', {
        preferredAdapter: 'api',
        preferredStrict: false,
        requestSource: 'background',
        maxAdapterAttempts: 5,
      });

      // Background should NOT retry on overloaded (only 1 attempt)
      expect(result.success).toBe(false);
      expect(attempt).toBe(1);
    });

    test('foreground + overloaded thrown error → retries same adapter (standard behavior)', async () => {
      // Bypass cooldown so we can observe the retry path in isolation
      // (same pattern as aiGateway.stability.test.js).
      gateway._recordAdapterFailure = () => {};

      let attempt = 0;
      const entry = createAdapterEntry('api', async () => {
        attempt++;
        if (attempt <= 1) {
          const err = new Error('overloaded');
          err.status = 529;
          err.statusCode = 529;
          throw err;
        }
        return { success: true, content: 'ok', provider: 'api', adapter: 'api' };
      });
      gateway._adapters = [entry];
      jest.spyOn(Math, 'random').mockReturnValue(0);

      const result = await gateway.generate('test', {
        preferredAdapter: 'api',
        preferredStrict: false,
        requestSource: 'foreground',
        maxAdapterAttempts: 5,
      });

      // Foreground should retry and eventually succeed
      expect(result.success).toBe(true);
      expect(attempt).toBe(2);
    });

    test('env KHY_BG_FAST_FAIL=0 → background requests retry normally', async () => {
      process.env.KHY_BG_FAST_FAIL = '0';
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
      // Bypass cooldown to isolate the retry-path test
      gateway._recordAdapterFailure = () => {};

      let attempt = 0;
      const entry = createAdapterEntry('api', async () => {
        attempt++;
        if (attempt <= 1) {
          const err = new Error('overloaded');
          err.status = 529;
          err.statusCode = 529;
          throw err;
        }
        return { success: true, content: 'ok', provider: 'api', adapter: 'api' };
      });
      gateway._adapters = [entry];
      jest.spyOn(Math, 'random').mockReturnValue(0);

      const result = await gateway.generate('test', {
        preferredAdapter: 'api',
        preferredStrict: false,
        requestSource: 'background',
        maxAdapterAttempts: 5,
      });

      // With fast-fail disabled, background retries like foreground
      expect(result.success).toBe(true);
      expect(attempt).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C. 401 Credential Auto-Refresh
  // ═══════════════════════════════════════════════════════════════════════════

  describe('C: 401 credential auto-refresh', () => {
    test('401 thrown + adapter with refreshCredential → refresh succeeds → retry succeeds', async () => {
      // Bypass cooldown: auth errors trigger a 30s fast-fail window which
      // would block the post-refresh retry. The stability tests use the
      // same pattern (gateway._recordAdapterFailure = () => {}).
      gateway._recordAdapterFailure = () => {};

      let attempt = 0;
      const entry = createAdapterEntry('trae', async () => {
        attempt++;
        if (attempt === 1) {
          const err = new Error('Unauthorized');
          err.status = 401;
          err.statusCode = 401;
          throw err;
        }
        return { success: true, content: 'ok after refresh', provider: 'trae', adapter: 'trae' };
      }, {
        refreshCredential: () => Promise.resolve({ token: 'new-token' }),
      });
      gateway._adapters = [entry];

      const result = await gateway.generate('test', {
        preferredAdapter: 'trae',
        preferredStrict: false,
        maxAdapterAttempts: 3,
      });

      expect(result.success).toBe(true);
      expect(entry.adapter.refreshCredential).toHaveBeenCalledTimes(1);
      expect(attempt).toBe(2);
    });

    test('BUG-1 regression: refresh success clears the auth cooldown — retry works WITHOUT stubbing _recordAdapterFailure', async () => {
      // Deliberately NO `gateway._recordAdapterFailure = () => {}` here: the
      // real failure recording populates the 30s auth fast-fail cache, and the
      // fix (_clearAdapterFailure on refresh success) must clear it so the
      // post-refresh same-adapter retry is not intercepted by
      // inspectCachedFastFail at the loop top.
      let attempt = 0;
      const entry = createAdapterEntry('trae', async () => {
        attempt++;
        if (attempt === 1) {
          const err = new Error('Unauthorized');
          err.status = 401;
          err.statusCode = 401;
          throw err;
        }
        return { success: true, content: 'ok after refresh', provider: 'trae', adapter: 'trae' };
      }, {
        refreshCredential: () => Promise.resolve({ token: 'new-token' }),
      });
      gateway._adapters = [entry];

      const result = await gateway.generate('test', {
        preferredAdapter: 'trae',
        preferredStrict: false,
        maxAdapterAttempts: 3,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('ok after refresh');
      expect(entry.adapter.refreshCredential).toHaveBeenCalledTimes(1);
      // The retry must have reached the adapter (not been cooldown-skipped)
      expect(attempt).toBe(2);
    });

    test('401 thrown + refresh fails → falls back to next adapter', async () => {
      const entry1 = createAdapterEntry('trae', async () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        err.statusCode = 401;
        throw err;
      }, {
        refreshCredential: () => Promise.reject(new Error('refresh network error')),
      });
      const entry2 = createAdapterEntry('cursor', async () => ({
        success: true,
        content: 'from cursor',
        provider: 'cursor',
        adapter: 'cursor',
      }));
      gateway._adapters = [entry1, entry2];

      const result = await gateway.generate('test', {
        preferredAdapter: 'trae',
        preferredStrict: false,
        maxAdapterAttempts: 2,
      });

      // Falls back to cursor after trae refresh fails
      expect(result.success).toBe(true);
      expect(result.adapter).toBe('cursor');
      expect(entry1.adapter.refreshCredential).toHaveBeenCalledTimes(1);
    });

    test('401 thrown + adapter WITHOUT refreshCredential → cascades to next adapter', async () => {
      const entry1 = createAdapterEntry('plain-api', async () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        err.statusCode = 401;
        throw err;
      });
      const entry2 = createAdapterEntry('fallback', async () => ({
        success: true,
        content: 'from fallback',
        provider: 'fallback',
        adapter: 'fallback',
      }));
      gateway._adapters = [entry1, entry2];

      const result = await gateway.generate('test', {
        preferredAdapter: 'plain-api',
        preferredStrict: false,
        maxAdapterAttempts: 1,
      });

      expect(result.success).toBe(true);
      expect(result.adapter).toBe('fallback');
    });

    test('env KHY_AUTO_CREDENTIAL_REFRESH=0 → no refresh attempted on 401', async () => {
      process.env.KHY_AUTO_CREDENTIAL_REFRESH = '0';
      jest.resetModules();
      gateway = require('../../src/services/gateway/aiGateway');
      gateway._initialized = true;
      gateway._initPromise = null;
      gateway._adapters = [];
      gateway._lastRefreshTime = Date.now();
      gateway.refreshAdapters = async () => {};
      gateway._enforceRateLimit = async () => {};
      neutralizeCacheEconomyStore();

      const refreshFn = jest.fn(() => Promise.resolve({ token: 'new' }));
      const entry = createAdapterEntry('trae', async () => {
        const err = new Error('Unauthorized');
        err.status = 401;
        err.statusCode = 401;
        throw err;
      }, { refreshCredential: refreshFn });
      const entry2 = createAdapterEntry('fallback', async () => ({
        success: true,
        content: 'fallback',
        provider: 'fallback',
        adapter: 'fallback',
      }));
      gateway._adapters = [entry, entry2];

      const result = await gateway.generate('test', {
        preferredAdapter: 'trae',
        preferredStrict: false,
        maxAdapterAttempts: 1,
      });

      // Refresh should NOT have been called
      expect(refreshFn).not.toHaveBeenCalled();
      // Should still succeed via fallback
      expect(result.success).toBe(true);
      expect(result.adapter).toBe('fallback');
    });
  });
});
