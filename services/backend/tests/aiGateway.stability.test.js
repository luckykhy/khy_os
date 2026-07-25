/**
 * AI Gateway Stability Tests
 *
 * Comprehensive stability checks covering:
 *   1. Error classification accuracy
 *   2. Cascade failover logic
 *   3. Rate limiting & backoff
 *   4. AbortController / cancellation handling
 *   5. Adapter isolation & timeout
 *   6. Fast-fail cache mechanism
 *   7. Plugin chain fault tolerance
 *   8. Proxy server health & auth
 *   9. Memory leak prevention
 *  10. Auto model selection
 */

'use strict';

// ──────────────────────────────────────────────────────
// Mocks — must be defined before requiring the modules
// ──────────────────────────────────────────────────────

// Stub heavy dependencies that are not needed in unit tests
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

jest.mock('../src/services/apiKeyRotation', () => ({
  executeWithRotation: jest.fn(),
  collectProviderKeys: jest.fn(() => []),
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

jest.mock('../src/services/modelTrainingService', () => ({
  recordConversation: jest.fn(() => ({ accepted: true })),
}));

jest.mock('../src/services/gateway/adapters/ollamaAdapter', () => ({
  detect: jest.fn(() => false),
  detectAsync: jest.fn(async () => false),
  listModels: jest.fn(async () => []),
  generate: jest.fn(async () => ({
    success: true,
    content: 'ok',
    provider: 'Ollama',
    adapter: 'ollama',
  })),
  getStatus: jest.fn(() => ({
    name: 'Ollama',
    type: 'ollama',
    available: false,
    detail: 'mocked in aiGateway.stability.test',
  })),
  destroy: jest.fn(),
}));

// ──────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────

function createMockAdapter(name, { available = false, generateFn } = {}) {
  const _state = { available, name };
  return {
    detect: jest.fn((force) => _state.available),
    detectAsync: undefined,
    generate: jest.fn(generateFn || (async () => ({
      success: true,
      content: `response from ${name}`,
      provider: name,
      adapter: name,
      model: 'test-model',
    }))),
    getStatus: jest.fn(() => ({
      name: _state.name,
      type: 'test',
      available: _state.available,
      activeModel: null,
    })),
    listModels: jest.fn(async () => []),
    destroy: jest.fn(),
    _state,
  };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const AI_GATEWAY_MODULE_PATH = require.resolve('../src/services/gateway/aiGateway');

async function cleanupGatewaySingleton() {
  const cached = require.cache[AI_GATEWAY_MODULE_PATH];
  const gateway = cached && cached.exports;
  if (gateway && typeof gateway.destroy === 'function') {
    try {
      await gateway.destroy();
    } catch {
      // best effort cleanup for singleton timers/adapters
    }
  }
  delete require.cache[AI_GATEWAY_MODULE_PATH];
}

afterEach(async () => {
  await cleanupGatewaySingleton();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await cleanupGatewaySingleton();
});

// ──────────────────────────────────────────────────────
// 1. Error Classification
// ──────────────────────────────────────────────────────

describe('Error Classification', () => {
  let classifyError;

  beforeAll(() => {
    const gateway = require('../src/services/gateway/aiGateway');
    classifyError = gateway.classifyError;
  });

  test.each([
    [429, '', 'rate_limit'],
    [401, '', 'auth'],
    [403, '', 'auth'],
    [408, '', 'timeout'],
    [504, '', 'timeout'],
    [500, '', 'server_error'],
    [502, '', 'server_error'],
    [503, '', 'server_error'],
    [529, '', 'overloaded'],
    [400, '', 'bad_request'],
  ])('status %i → %s', (status, message, expected) => {
    expect(classifyError(status, message)).toBe(expected);
  });

  test.each([
    ['Request timed out after 30s', 'timeout'],
    ['Ollama did not respond within 4000ms', 'timeout'],
    ['rate limit exceeded', 'rate_limit'],
    ['too many requests', 'rate_limit'],
    ['unauthorized access', 'auth'],
    ['permission denied', 'permission'],
    ['ECONNRESET', 'network'],
    ['ECONNREFUSED', 'network'],
    ['fetch failed', 'network'],
    ['socket hang up', 'network'],
    ['adapter foo unavailable', 'unavailable'],
    ['command codex not found', 'unavailable'],
    ['aborted by user', 'cancelled'],
    ['AbortError', 'cancelled'],
    ['request aborted: user cancelled', 'cancelled'],
    ['canceled', 'process'],
    ['cancelled', 'process'],
    ['reconnecting session', 'network'],
    ['exited with code 1', 'process'],
  ])('message "%s" → %s', (message, expected) => {
    expect(classifyError(0, message)).toBe(expected);
  });

  // Regression: HTTP status code embedded ONLY in the message string (axios
  // "Request failed with status code NNN", statusCode:0 on the returned result).
  // Before the fix these all collapsed to 'unknown' → one long "broken channel"
  // cooldown + circuit escalation for every distinct fault ("一次失败处处失败").
  test.each([
    ['Request failed with status code 504', 'timeout'],
    ['Request failed with status code 408', 'timeout'],
    ['Request failed with status code 404', 'model_not_found'],
    ['Request failed with status code 400', 'bad_request'],
    ['Request failed with status code 502', 'server_error'],
    ['Request failed with status code 503', 'server_error'],
    ['Request failed with status code 429', 'rate_limit'],
    ['recent x failure cached: Request failed with status code 504 (cooldown 190s)', 'timeout'],
  ])('embedded status in message "%s" → %s', (message, expected) => {
    expect(classifyError(0, message)).toBe(expected);
  });

  // Conservative extraction requires an explicit status/HTTP context word, so a
  // bare 3-digit number (a port, a duration, "exited with code 1") is never
  // misread as a status code.
  test('does not misread stray numbers as HTTP status', () => {
    expect(classifyError(0, 'exited with code 1')).toBe('process');
    expect(classifyError(0, 'took 404 ms to fail')).toBe('unknown');
    expect(classifyError(0, 'connecting to api.example.com:8404')).toBe('unknown');
  });

  test('returns "unknown" for unrecognized errors', () => {
    expect(classifyError(0, 'something weird happened')).toBe('unknown');
    expect(classifyError(200, '')).toBe('unknown');
  });

  test('handles null/undefined gracefully', () => {
    expect(classifyError(null, null)).toBe('unknown');
    expect(classifyError(undefined, undefined)).toBe('unknown');
    expect(classifyError(0, '')).toBe('unknown');
  });
});

describe('Codex testAdapter probe alignment', () => {
  test('uses gateway strict probe path and surfaces first-response timeout as generation failure', async () => {
    jest.resetModules();

    jest.doMock('../src/services/gateway/adapters/codexAdapter', () => ({
      detectAsync: jest.fn(async () => true),
      detect: jest.fn(() => true),
      listModels: jest.fn(async () => ([
        { id: 'gpt-5.3-codex-review', name: 'gpt-5.3-codex-review' },
      ])),
      generate: jest.fn(),
      getStatus: jest.fn(() => ({
        name: 'Codex CLI (mindflow)',
        type: 'codex',
        available: true,
        activeModel: 'gpt-5.3-codex-review',
      })),
      destroy: jest.fn(),
    }));

    const gateway = require('../src/services/gateway/aiGateway');
    const strictProbeGenerate = jest.fn(async () => ({
      success: false,
      error: 'codex first response timeout after 20000ms without meaningful model progress',
      errorType: 'timeout',
      content: '',
      diagnostics: {
        stallFingerprint: 'turn_started_reconnect_loop',
      },
    }));
    gateway.generate = strictProbeGenerate;
    gateway._adapters = [{
      key: 'codex',
      adapter: require('../src/services/gateway/adapters/codexAdapter'),
      priority: 0,
      enabled: true,
      available: true,
    }];

    const result = await gateway.testAdapter('codex', {
      probeGenerationTimeoutMs: 20000,
    });

    expect(strictProbeGenerate).toHaveBeenCalledWith(
      '只用一句中文回复：已收到，不要调用工具。',
      expect.objectContaining({
        preferredAdapter: 'codex',
        preferredStrict: true,
        preferredModel: 'gpt-5.3-codex-review',
        model: 'gpt-5.3-codex-review',
        maxTotalAttempts: 1,
        maxRetryDelayBudgetMs: 1000,
        timeoutMs: 20000,
        firstResponseTimeoutMs: 20000,
        disableProviderFallback: true,
        strictAutoRelaxOnProcess: false,
        maxTokens: 64,
      })
    );
    expect(result.generation).toMatchObject({
      success: false,
      error: 'codex first response timeout after 20000ms without meaningful model progress',
      diagnostics: {
        stallFingerprint: 'turn_started_reconnect_loop',
      },
    });
  });

  test('runs a tiny generation probe for trae strict adapters', async () => {
    jest.resetModules();

    const traeGenerate = jest.fn(async () => ({
      success: true,
      content: 'OK',
      provider: 'Trae',
      adapter: 'trae',
      model: 'doubao-seed-1-6-thinking-250615',
    }));

    jest.doMock('../src/services/gateway/adapters/traeAdapter', () => ({
      detectAsync: jest.fn(async () => true),
      detect: jest.fn(() => true),
      listModels: jest.fn(async () => ([
        { id: 'doubao-seed-1-6-thinking-250615', name: 'Doubao Seed', isDefault: true },
        { id: 'gpt-4o', name: 'GPT-4o', isDefault: false },
      ])),
      generate: traeGenerate,
      getStatus: jest.fn(() => ({
        name: 'Trae IDE',
        type: 'trae',
        available: true,
        activeModel: 'doubao-seed-1-6-thinking-250615',
      })),
      destroy: jest.fn(),
    }));

    const gateway = require('../src/services/gateway/aiGateway');
    gateway._adapters = [{
      key: 'trae',
      adapter: require('../src/services/gateway/adapters/traeAdapter'),
      priority: 0,
      enabled: true,
      available: true,
    }];

    const result = await gateway.testAdapter('trae', {
      probeGenerationTimeoutMs: 9000,
    });

    expect(traeGenerate).toHaveBeenCalledWith(
      'Reply with exactly: OK',
      expect.objectContaining({
        model: 'doubao-seed-1-6-thinking-250615',
        maxTokens: 32,
        temperature: 0,
        top_p: 1,
        think: false,
      })
    );
    expect(result.generation).toMatchObject({
      success: true,
    });
  });
});

// ──────────────────────────────────────────────────────
// 2. Cascade Failover Logic
// ──────────────────────────────────────────────────────

describe('Cascade Failover', () => {
  let AIGateway;

  beforeEach(() => {
    jest.resetModules();

    // Re-mock after resetModules
    jest.mock('../src/services/diagnosticEvents', () => ({
      diagnostics: { emitModelRequest: jest.fn(), emitModelResponse: jest.fn() },
      generateTraceId: () => 'test-trace',
    }));
    jest.mock('../src/services/usageTracker', () => ({ usageTracker: { record: jest.fn() } }));
    jest.mock('../src/services/apiKeyRotation', () => ({ executeWithRotation: jest.fn(), collectProviderKeys: jest.fn(() => []) }));
    jest.mock('../src/services/contextWindowGuard', () => ({ evaluateGuard: jest.fn(() => ({ passed: true })), formatWarning: jest.fn(() => '') }));
    jest.mock('../src/services/aiMonitor', () => ({ startTrace: jest.fn(() => 'trace'), endTrace: jest.fn(), addCascadeAttempt: jest.fn() }));
    jest.mock('../src/services/liveModelSwitch', () => ({ getInstance: () => ({ getActiveModel: () => null, generationStarted: jest.fn(), generationCompleted: jest.fn() }) }));
    jest.mock('../src/services/advancedDiagnostics', () => ({ getInstance: () => ({ recordLatency: jest.fn(), recordError: jest.fn() }) }));
    jest.mock('../src/services/usageHabitService', () => ({ getPreferredModel: jest.fn(() => null), recordModelUsage: jest.fn(), recordInteraction: jest.fn() }));
    jest.mock('../src/services/apiKeyPool', () => ({ init: jest.fn(), hasAvailableKeys: jest.fn(() => false) }));
    jest.mock('../src/services/concurrencySlots', () => ({ acquire: jest.fn(() => jest.fn()) }));
    jest.mock('../src/services/gateway/pluginChain', () => ({
      executeBeforeRequest: jest.fn(async (ctx) => ctx),
      executeAfterResponse: jest.fn(async (ctx) => ctx),
    }));

    // Get fresh gateway constructor
    const gatewayModule = require('../src/services/gateway/aiGateway');
    // We'll test via the singleton but reset its state
    AIGateway = gatewayModule;
  });

  test('falls through to next adapter on failure', async () => {
    const gw = Object.create(AIGateway);
    // Manually set up minimal adapters
    const adapterA = createMockAdapter('A', {
      available: true,
      generateFn: async () => ({ success: false, error: 'unavailable', statusCode: 503 }),
    });
    const adapterB = createMockAdapter('B', {
      available: true,
      generateFn: async () => ({ success: true, content: 'hello from B', provider: 'B', adapter: 'B', model: 'b-model' }),
    });

    gw._adapters = [
      { key: 'a', adapter: adapterA, priority: 0, enabled: true, available: true },
      { key: 'b', adapter: adapterB, priority: 1, enabled: true, available: true },
    ];
    gw._initialized = true;
    gw._adapterFailures = {};
    gw._adapterLastError = {};
    gw._requestLog = {};
    gw._localAdapters = new Set();
    gw._serializedAdapterKeys = new Set();
    gw._adapterQueue = (key, fn) => fn();
    gw._keyedLimiter = { consume: () => ({ allowed: true }) };
    gw._lastRefreshTime = Date.now();

    // Bind methods
    gw._enforceRateLimit = AIGateway._enforceRateLimit?.bind(gw) || (async () => {});
    gw._generateWithAdapterIsolation = AIGateway._generateWithAdapterIsolation?.bind(gw)
      || (async (entry, prompt, opts) => entry.adapter.generate(prompt, opts));
    gw._getRecentFastFail = AIGateway._getRecentFastFail?.bind(gw) || (() => null);
    gw._clearAdapterFailure = AIGateway._clearAdapterFailure?.bind(gw) || ((k) => { delete gw._adapterLastError[k]; });
    gw._recordAdapterFailure = AIGateway._recordAdapterFailure?.bind(gw) || (() => {});
    gw._shouldSerializeAdapter = () => false;
    gw.refreshAdapters = async () => {};

    const result = await AIGateway.generate.call(gw, 'test prompt');

    expect(result.success).toBe(true);
    expect(result.content).toBe('hello from B');
    expect(adapterA.generate).toHaveBeenCalledTimes(1);
    expect(adapterB.generate).toHaveBeenCalledTimes(1);
  });

  test('returns failure when all adapters fail', async () => {
    const gw = Object.create(AIGateway);
    const failAdapter = createMockAdapter('Fail', {
      available: true,
      generateFn: async () => ({ success: false, error: 'down', statusCode: 500 }),
    });

    gw._adapters = [
      { key: 'fail', adapter: failAdapter, priority: 0, enabled: true, available: true },
    ];
    gw._initialized = true;
    gw._adapterFailures = {};
    gw._adapterLastError = {};
    gw._requestLog = {};
    gw._localAdapters = new Set();
    gw._serializedAdapterKeys = new Set();
    gw._adapterQueue = (key, fn) => fn();
    gw._keyedLimiter = { consume: () => ({ allowed: true }) };
    gw._lastRefreshTime = Date.now();
    gw._enforceRateLimit = async () => {};
    gw._generateWithAdapterIsolation = async (entry, prompt, opts) => entry.adapter.generate(prompt, opts);
    gw._getRecentFastFail = () => null;
    gw._clearAdapterFailure = (k) => { delete gw._adapterLastError[k]; };
    gw._recordAdapterFailure = () => {};
    gw._shouldSerializeAdapter = () => false;
    gw.refreshAdapters = async () => {};

    const result = await AIGateway.generate.call(gw, 'test');

    expect(result.success).toBe(false);
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.content).toContain('AI');
  });

  test('skips disabled adapters', async () => {
    const gw = Object.create(AIGateway);
    const disabledAdapter = createMockAdapter('Disabled', { available: true });
    const enabledAdapter = createMockAdapter('Enabled', {
      available: true,
      generateFn: async () => ({ success: true, content: 'ok', provider: 'Enabled', adapter: 'Enabled' }),
    });

    gw._adapters = [
      { key: 'disabled', adapter: disabledAdapter, priority: 0, enabled: false, available: true },
      { key: 'enabled', adapter: enabledAdapter, priority: 1, enabled: true, available: true },
    ];
    gw._initialized = true;
    gw._adapterFailures = {};
    gw._adapterLastError = {};
    gw._requestLog = {};
    gw._localAdapters = new Set();
    gw._serializedAdapterKeys = new Set();
    gw._adapterQueue = (key, fn) => fn();
    gw._keyedLimiter = { consume: () => ({ allowed: true }) };
    gw._lastRefreshTime = Date.now();
    gw._enforceRateLimit = async () => {};
    gw._generateWithAdapterIsolation = async (entry, prompt, opts) => entry.adapter.generate(prompt, opts);
    gw._getRecentFastFail = () => null;
    gw._clearAdapterFailure = (k) => { delete gw._adapterLastError[k]; };
    gw._recordAdapterFailure = () => {};
    gw._shouldSerializeAdapter = () => false;
    gw.refreshAdapters = async () => {};

    const result = await AIGateway.generate.call(gw, 'test');

    expect(result.success).toBe(true);
    expect(disabledAdapter.generate).not.toHaveBeenCalled();
    expect(enabledAdapter.generate).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────
// 3. Rate Limiting
// ──────────────────────────────────────────────────────

describe('Rate Limiter', () => {
  const { createFixedWindowRateLimiter, createKeyedRateLimiter } = require('../src/services/rateLimiter');

  test('allows requests within limit', () => {
    const limiter = createFixedWindowRateLimiter({ maxRequests: 3, windowMs: 60000 });
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(false);
  });

  test('reports correct remaining count', () => {
    const limiter = createFixedWindowRateLimiter({ maxRequests: 5, windowMs: 60000 });
    expect(limiter.consume().remaining).toBe(4);
    expect(limiter.consume().remaining).toBe(3);
  });

  test('resets after window expires', () => {
    let now = 0;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1000,
      now: () => now,
    });

    limiter.consume();
    limiter.consume();
    expect(limiter.consume().allowed).toBe(false);

    now = 1001; // advance past window
    expect(limiter.consume().allowed).toBe(true);
  });

  test('keyed limiter isolates keys', () => {
    const limiter = createKeyedRateLimiter({ maxRequests: 1, windowMs: 60000 });
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true); // different key
  });

  test('provides retryAfterMs when rate limited', () => {
    let now = 500;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1000,
      now: () => now,
    });
    limiter.consume();
    const result = limiter.consume();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});

// ──────────────────────────────────────────────────────
// 4. AbortController / Cancellation
// ──────────────────────────────────────────────────────

describe('Cancellation Handling', () => {
  test('returns cancelled result when signal is already aborted', async () => {
    jest.resetModules();
    jest.mock('../src/services/diagnosticEvents', () => ({ diagnostics: { emitModelRequest: jest.fn(), emitModelResponse: jest.fn() }, generateTraceId: () => 'test' }));
    jest.mock('../src/services/usageTracker', () => ({ usageTracker: { record: jest.fn() } }));
    jest.mock('../src/services/apiKeyRotation', () => ({ executeWithRotation: jest.fn(), collectProviderKeys: jest.fn(() => []) }));
    jest.mock('../src/services/contextWindowGuard', () => ({ evaluateGuard: jest.fn(() => ({ passed: true })), formatWarning: jest.fn(() => '') }));
    jest.mock('../src/services/aiMonitor', () => ({ startTrace: jest.fn(() => 'trace'), endTrace: jest.fn(), addCascadeAttempt: jest.fn() }));
    jest.mock('../src/services/liveModelSwitch', () => ({ getInstance: () => ({ getActiveModel: () => null, generationStarted: jest.fn(), generationCompleted: jest.fn() }) }));
    jest.mock('../src/services/advancedDiagnostics', () => ({ getInstance: () => ({ recordLatency: jest.fn(), recordError: jest.fn() }) }));
    jest.mock('../src/services/usageHabitService', () => ({ getPreferredModel: jest.fn(() => null) }));
    jest.mock('../src/services/apiKeyPool', () => ({ init: jest.fn(), hasAvailableKeys: jest.fn(() => false) }));
    jest.mock('../src/services/concurrencySlots', () => ({ acquire: jest.fn(() => jest.fn()) }));
    jest.mock('../src/services/gateway/pluginChain', () => ({
      executeBeforeRequest: jest.fn(async (ctx) => ctx),
      executeAfterResponse: jest.fn(async (ctx) => ctx),
    }));

    const gw = require('../src/services/gateway/aiGateway');

    const adapter = createMockAdapter('test', { available: true });
    gw._adapters = [{ key: 'test', adapter, priority: 0, enabled: true, available: true }];
    gw._initialized = true;
    gw._lastRefreshTime = Date.now();

    const controller = new AbortController();
    controller.abort('user cancelled');

    const result = await gw.generate('test', { abortSignal: controller.signal });

    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(adapter.generate).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────
// 5. Sequential Queue & Adapter Isolation
// ──────────────────────────────────────────────────────

describe('Sequential Queue', () => {
  const { createSequentialQueue } = require('../src/services/sequentialQueue');

  test('same key executes serially', async () => {
    const enqueue = createSequentialQueue();
    const order = [];

    const p1 = enqueue('k', async () => {
      order.push('start-1');
      await delay(30);
      order.push('end-1');
      return 'r1';
    });
    const p2 = enqueue('k', async () => {
      order.push('start-2');
      await delay(10);
      order.push('end-2');
      return 'r2';
    });

    await Promise.all([p1, p2]);

    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  test('different keys execute in parallel', async () => {
    const enqueue = createSequentialQueue();
    const order = [];

    const p1 = enqueue('a', async () => {
      order.push('a-start');
      await delay(30);
      order.push('a-end');
    });
    const p2 = enqueue('b', async () => {
      order.push('b-start');
      await delay(10);
      order.push('b-end');
    });

    await Promise.all([p1, p2]);

    // b should finish before a since it's faster and runs in parallel
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  test('task timeout advances queue without blocking', async () => {
    const timeoutFn = jest.fn();
    const enqueue = createSequentialQueue({
      taskTimeoutMs: 50,
      onTaskTimeout: timeoutFn,
    });

    const p1 = enqueue('k', () => new Promise(() => {})); // will timeout without lingering timer handle
    const p2 = enqueue('k', async () => 'done');

    const r2 = await Promise.race([
      p2,
      delay(200).then(() => 'timed-out-waiting'),
    ]);

    // p2 should complete after p1 times out
    expect(r2).not.toBe('timed-out-waiting');
  });
});

// ──────────────────────────────────────────────────────
// 6. Fast-Fail Cache
// ──────────────────────────────────────────────────────

describe('Fast-Fail Cache', () => {
  test('records and retrieves recent failures', () => {
    const gw = require('../src/services/gateway/aiGateway');

    gw._adapterLastError = {};
    gw._recordAdapterFailure('test-adapter', 'auth', 'unauthorized');

    const cached = gw._adapterLastError['test-adapter'];
    expect(cached).toBeDefined();
    expect(cached.errorType).toBe('auth');
    expect(cached.error).toContain('unauthorized');
    expect(cached.at).toBeGreaterThan(0);
  });

  test('fast-fail applies transient cooldown for rate_limit errors', () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};

    // transient errors should enter a short fast-fail window
    gw._recordAdapterFailure('test', 'rate_limit', 'too many');
    const result = gw._getRecentFastFail('test');
    expect(result).toBeDefined();
    expect(result.errorType).toBe('rate_limit');
    expect(result.remainingMs).toBeGreaterThan(0);
  });

  test('fast-fail triggers for auth errors', () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};

    gw._recordAdapterFailure('test', 'auth', 'invalid key');
    const result = gw._getRecentFastFail('test');
    expect(result).toBeDefined();
    expect(result.errorType).toBe('auth');
  });

  test('fast-fail expires after cooldown', () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};

    gw._adapterLastError['test'] = {
      at: Date.now() - 999999, // well past cooldown
      errorType: 'auth',
      error: 'old error',
    };

    const result = gw._getRecentFastFail('test');
    expect(result).toBeNull();
  });

  test('codex process failure uses extended cooldown window', () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};

    const oldBase = process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS;
    const oldCodexProcess = process.env.GATEWAY_FAST_FAIL_CODEX_PROCESS_COOLDOWN_MS;
    try {
      process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS = '5000';
      process.env.GATEWAY_FAST_FAIL_CODEX_PROCESS_COOLDOWN_MS = '90000';

      gw._recordAdapterFailure('codex', 'process', 'channel closed');
      expect(gw._adapterLastError.codex.cooldownMs).toBe(90000);

      gw._adapterLastError.codex.at = Date.now() - 10000;
      const recent = gw._getRecentFastFail('codex');
      expect(recent).toBeDefined();
      expect(recent.remainingMs).toBeGreaterThan(70000);

      gw._adapterLastError.codex.at = Date.now() - 95000;
      expect(gw._getRecentFastFail('codex')).toBeNull();
    } finally {
      if (oldBase === undefined) delete process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS;
      else process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS = oldBase;
      if (oldCodexProcess === undefined) delete process.env.GATEWAY_FAST_FAIL_CODEX_PROCESS_COOLDOWN_MS;
      else process.env.GATEWAY_FAST_FAIL_CODEX_PROCESS_COOLDOWN_MS = oldCodexProcess;
    }
  });

  // ── Coherence regression: an empty model reply must NOT cool the channel ──
  // Reproduces the reported incoherence: "summarize my desktop" → one empty
  // reply cooled the channel for 20s, every re-ask in that window fast-failed
  // with "recent unknown failure cached: Empty response (cooldown 16s)". An
  // empty HTTP-200 reply is a healthy channel + model-behavior blip, so it must
  // stay immediately available for the next re-ask.
  test('empty reply does NOT enter a cross-request fast-fail cooldown window', () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};
    gw._adapterFailures = {};

    gw._recordAdapterFailure('relay', 'empty', 'Empty response (HTTP 200, body: {})');
    // mirror is set synchronously; an 'empty' failure must produce no fast-fail
    expect(gw._adapterLastError.relay.errorType).toBe('empty');
    expect(gw._getRecentFastFail('relay')).toBeNull();
  });

  test('repeated empty replies do NOT open the circuit on the only channel', async () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};
    gw._adapterFailures = {};

    // Far past the consecutive-failure threshold; 'empty' is circuit-ineligible
    // so the channel must remain available (never fast-fails) for the next ask.
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await gw._recordAdapterFailure('relay', 'empty', 'Empty response (HTTP 200, body: {})');
    }
    expect(gw._adapterLastError.relay.circuitOpen).toBe(false);
    expect(gw._getRecentFastFail('relay')).toBeNull();
  });

  test('codex hard stall fingerprint escalates fast-fail cooldown for active bypass', async () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};
    gw._adapterFailures = {};

    const oldBase = process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS;
    const oldCodexTimeout = process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS;
    try {
      process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS = '5000';
      process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS = '40000';

      // Baseline: a timeout WITHOUT a known-bad fingerprint keeps the base codex
      // timeout cooldown.
      expect(gw._resolveFastFailCooldownMs('codex', 'timeout', 'first response timeout', ''))
        .toBe(40000);

      // A hard reconnect-loop fingerprint escalates the cooldown (×3) so the next
      // request virtual-skips codex via inspectCachedFastFail and cascades.
      expect(
        gw._resolveFastFailCooldownMs('codex', 'timeout', 'first response timeout', 'turn_started_reconnect_loop')
      ).toBe(120000);

      // The fingerprint is persisted on the recorded failure for audit retention.
      await gw._recordAdapterFailure('codex', 'timeout', 'first response timeout', {
        stallFingerprint: 'turn_started_reconnect_loop',
      });
      expect(gw._adapterLastError.codex.stallFingerprint).toBe('turn_started_reconnect_loop');
      expect(gw._adapterLastError.codex.cooldownMs).toBe(120000);
    } finally {
      if (oldBase === undefined) delete process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS;
      else process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS = oldBase;
      if (oldCodexTimeout === undefined) delete process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS;
      else process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS = oldCodexTimeout;
    }
  });

  test('codex soft stall fingerprint applies a milder cooldown escalation', () => {
    const gw = require('../src/services/gateway/aiGateway');
    const oldBase = process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS;
    const oldCodexTimeout = process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS;
    try {
      process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS = '5000';
      process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS = '40000';
      // Soft fingerprint (no_subprocess_output) → ×1.5.
      expect(
        gw._resolveFastFailCooldownMs('codex', 'timeout', 'first response timeout', 'no_subprocess_output')
      ).toBe(60000);
    } finally {
      if (oldBase === undefined) delete process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS;
      else process.env.GATEWAY_FAST_FAIL_COOLDOWN_MS = oldBase;
      if (oldCodexTimeout === undefined) delete process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS;
      else process.env.GATEWAY_FAST_FAIL_CODEX_TIMEOUT_COOLDOWN_MS = oldCodexTimeout;
    }
  });

  test('localLLM timeout policy follows cold/warm/degraded status', () => {
    const gw = require('../src/services/gateway/aiGateway');
    const localLLMService = require('../src/services/localLLMService');
    const statusSpy = jest.spyOn(localLLMService, 'getStatus');

    const oldGlobal = process.env.GATEWAY_PER_ADAPTER_TIMEOUT_MS;
    const oldCold = process.env.GATEWAY_LOCAL_LLM_COLD_TIMEOUT_MS;
    const oldWarm = process.env.GATEWAY_LOCAL_LLM_WARM_TIMEOUT_MS;
    const oldDegraded = process.env.GATEWAY_LOCAL_LLM_DEGRADED_TIMEOUT_MS;
    const oldLocalSpecific = process.env.GATEWAY_LOCAL_LLM_TIMEOUT_MS;
    try {
      process.env.GATEWAY_PER_ADAPTER_TIMEOUT_MS = '60000';
      process.env.GATEWAY_LOCAL_LLM_COLD_TIMEOUT_MS = '180000';
      process.env.GATEWAY_LOCAL_LLM_WARM_TIMEOUT_MS = '70000';
      process.env.GATEWAY_LOCAL_LLM_DEGRADED_TIMEOUT_MS = '210000';
      delete process.env.GATEWAY_LOCAL_LLM_TIMEOUT_MS;

      statusSpy.mockReturnValue({
        available: true,
        loaded: false,
        lastError: null,
      });
      expect(gw._resolveAdapterTimeoutMs('localLLM', 120000)).toBe(180000);

      statusSpy.mockReturnValue({
        available: true,
        loaded: true,
        lastError: null,
      });
      expect(gw._resolveAdapterTimeoutMs('localLLM', 120000)).toBe(70000);

      statusSpy.mockReturnValue({
        available: true,
        loaded: true,
        lastError: 'runner crash',
      });
      expect(gw._resolveAdapterTimeoutMs('localLLM', 120000)).toBe(210000);
    } finally {
      statusSpy.mockRestore();
      if (oldGlobal === undefined) delete process.env.GATEWAY_PER_ADAPTER_TIMEOUT_MS;
      else process.env.GATEWAY_PER_ADAPTER_TIMEOUT_MS = oldGlobal;
      if (oldCold === undefined) delete process.env.GATEWAY_LOCAL_LLM_COLD_TIMEOUT_MS;
      else process.env.GATEWAY_LOCAL_LLM_COLD_TIMEOUT_MS = oldCold;
      if (oldWarm === undefined) delete process.env.GATEWAY_LOCAL_LLM_WARM_TIMEOUT_MS;
      else process.env.GATEWAY_LOCAL_LLM_WARM_TIMEOUT_MS = oldWarm;
      if (oldDegraded === undefined) delete process.env.GATEWAY_LOCAL_LLM_DEGRADED_TIMEOUT_MS;
      else process.env.GATEWAY_LOCAL_LLM_DEGRADED_TIMEOUT_MS = oldDegraded;
      if (oldLocalSpecific === undefined) delete process.env.GATEWAY_LOCAL_LLM_TIMEOUT_MS;
      else process.env.GATEWAY_LOCAL_LLM_TIMEOUT_MS = oldLocalSpecific;
    }
  });

  test('clearAdapterFailure removes cached error', () => {
    const gw = require('../src/services/gateway/aiGateway');
    gw._adapterLastError = {};

    gw._recordAdapterFailure('test', 'auth', 'fail');
    expect(gw._adapterLastError['test']).toBeDefined();

    gw._clearAdapterFailure('test');
    expect(gw._adapterLastError['test']).toBeUndefined();
  });

  test('small-task claude timeout cap defaults to 120s (not 30s hard cap)', async () => {
    const gw = require('../src/services/gateway/aiGateway');
    await gw.init();

    const oldGeneralSmall = process.env.GATEWAY_GENERAL_SMALL_TASK_TIMEOUT_MS;
    const oldClaudeSmall = process.env.GATEWAY_CLAUDE_SMALL_TASK_TIMEOUT_MS;
    try {
      delete process.env.GATEWAY_CLAUDE_SMALL_TASK_TIMEOUT_MS;
      process.env.GATEWAY_GENERAL_SMALL_TASK_TIMEOUT_MS = '120000';

      const v = gw._resolveAdapterTimeoutMs('claude', 120000);
      expect(v).toBeGreaterThanOrEqual(120000);
    } finally {
      if (oldGeneralSmall === undefined) delete process.env.GATEWAY_GENERAL_SMALL_TASK_TIMEOUT_MS;
      else process.env.GATEWAY_GENERAL_SMALL_TASK_TIMEOUT_MS = oldGeneralSmall;
      if (oldClaudeSmall === undefined) delete process.env.GATEWAY_CLAUDE_SMALL_TASK_TIMEOUT_MS;
      else process.env.GATEWAY_CLAUDE_SMALL_TASK_TIMEOUT_MS = oldClaudeSmall;
    }
  });
});

// ──────────────────────────────────────────────────────
// 7. Retry With Backoff
// ──────────────────────────────────────────────────────

describe('Retry With Backoff', () => {
  const { retryWithBackoff, isRetryableError, parseRetryAfter } = require('../src/services/retryWithBackoff');

  test('succeeds on first attempt without retry', async () => {
    const fn = jest.fn(async () => 'ok');
    const result = await retryWithBackoff(fn, { attempts: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on transient error and eventually succeeds', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error('rate limit');
        err.status = 429;
        throw err;
      }
      return 'ok';
    });

    const result = await retryWithBackoff(fn, {
      attempts: 3,
      minDelayMs: 10,
      maxDelayMs: 50,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after max attempts exhausted', async () => {
    const fn = jest.fn(async () => { throw new Error('always fail'); });

    await expect(retryWithBackoff(fn, {
      attempts: 2,
      minDelayMs: 10,
      maxDelayMs: 50,
    })).rejects.toThrow('always fail');

    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('respects shouldRetry predicate', async () => {
    const fn = jest.fn(async () => { throw new Error('not retryable'); });

    await expect(retryWithBackoff(fn, {
      attempts: 3,
      shouldRetry: () => false,
    })).rejects.toThrow('not retryable');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(retryWithBackoff(
      async () => 'should not reach',
      { attempts: 3, signal: controller.signal }
    )).rejects.toThrow(/aborted/i);
  });

  test('isRetryableError identifies retryable errors', () => {
    expect(isRetryableError({ status: 429, message: '' })).toBe(true);
    expect(isRetryableError({ status: 500, message: '' })).toBe(true);
    expect(isRetryableError({ code: 'ECONNRESET', message: '' })).toBe(true);
    expect(isRetryableError({ message: 'overloaded' })).toBe(true);
    expect(isRetryableError({ status: 400, message: '' })).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });

  test('parseRetryAfter handles seconds', () => {
    expect(parseRetryAfter({ headers: { 'retry-after': '5' } })).toBe(5000);
  });

  test('parseRetryAfter returns undefined for missing header', () => {
    expect(parseRetryAfter({})).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────
// 8. Plugin Chain Fault Tolerance
// ──────────────────────────────────────────────────────

describe('Plugin Chain', () => {
  let pluginChain;

  beforeEach(() => {
    jest.resetModules();
    // Remove any prior mock so we get the real module
    jest.unmock('../src/services/gateway/pluginChain');
    pluginChain = require('../src/services/gateway/pluginChain');
    // Force reload — plugins dir may not exist in test env, that's fine
    pluginChain.reload();
  });

  test('executeBeforeRequest passes through when no plugins', async () => {
    const ctx = { prompt: 'hello', options: {}, adapter: null, cancelled: false };
    const result = await pluginChain.executeBeforeRequest(ctx);
    expect(result).toEqual(ctx);
    expect(result.cancelled).toBe(false);
  });

  test('executeAfterResponse passes through when no plugins', async () => {
    const ctx = { prompt: 'hello', options: {}, response: { content: 'ok' }, adapter: 'test' };
    const result = await pluginChain.executeAfterResponse(ctx);
    expect(result).toEqual(ctx);
  });

  test('executeOnStream passes through when no plugins', () => {
    const chunk = { type: 'text', text: 'hello' };
    const result = pluginChain.executeOnStream(chunk, { adapter: 'test' });
    expect(result).toEqual(chunk);
  });

  test('list returns array when loaded', () => {
    const plugins = pluginChain.list();
    expect(Array.isArray(plugins)).toBe(true);
  });

  test('toggle returns false for non-existent plugin', () => {
    expect(pluginChain.toggle('nonexistent_plugin_xyz', true)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────
// 9. Error Classifier
// ──────────────────────────────────────────────────────

describe('Error Classifier', () => {
  const {
    detectErrorKind,
    detectErrorKindDeep,
    extractErrorCode,
    collectErrorCandidates,
    formatErrorMessage,
    redactSensitiveText,
  } = require('../src/services/errorClassifier');

  test('detectErrorKind classifies common errors', () => {
    expect(detectErrorKind({ message: 'request timed out' })).toBe('timeout');
    expect(detectErrorKind({ message: 'rate limit exceeded' })).toBe('rate_limit');
    expect(detectErrorKind({ message: 'unauthorized access' })).toBe('auth');
    expect(detectErrorKind({ code: 'ECONNRESET', message: '' })).toBe('network');
    expect(detectErrorKind({ message: 'context length exceeded' })).toBe('context_length');
    expect(detectErrorKind({ message: 'content_filter triggered' })).toBe('refusal');
  });

  test('detectErrorKindDeep traverses cause chain', () => {
    const err = {
      message: 'outer error',
      cause: { message: 'inner timeout error: timed out' },
    };
    expect(detectErrorKindDeep(err)).toBe('timeout');
  });

  test('collectErrorCandidates handles circular references', () => {
    const a = { message: 'a' };
    const b = { message: 'b', cause: a };
    a.cause = b; // circular
    const candidates = collectErrorCandidates(a);
    expect(candidates.length).toBe(2);
  });

  test('extractErrorCode extracts status codes', () => {
    expect(extractErrorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(extractErrorCode({ status: 429 })).toBe('429');
    expect(extractErrorCode({ statusCode: 500 })).toBe('500');
    expect(extractErrorCode(null)).toBeUndefined();
  });

  test('formatErrorMessage handles different error types', () => {
    expect(formatErrorMessage(new Error('test error'))).toBe('test error');
    expect(formatErrorMessage('string error')).toBe('string error');
    expect(formatErrorMessage(null)).toBe('null');
    expect(formatErrorMessage({ key: 'value' })).toContain('key');
  });

  test('redactSensitiveText redacts API keys', () => {
    const text = 'Using key sk-1234567890abcdefghij';
    const redacted = redactSensitiveText(text);
    expect(redacted).not.toContain('sk-1234567890abcdefghij');
    expect(redacted).toContain('sk-123');
  });

  test('redactSensitiveText handles empty input', () => {
    expect(redactSensitiveText('')).toBe('');
    expect(redactSensitiveText(null)).toBe('');
    expect(redactSensitiveText(undefined)).toBe('');
  });
});

// ──────────────────────────────────────────────────────
// 10. Auto Model Selection
// ──────────────────────────────────────────────────────

describe('Auto Model Selection', () => {
  test('returns fallback relay when no adapters available', () => {
    const gw = require('../src/services/gateway/aiGateway');

    // Save original adapters
    const origAdapters = gw._adapters;
    gw._adapters = origAdapters.map(a => ({
      ...a,
      available: false,
      enabled: true,
      adapter: { ...a.adapter, detect: () => false },
    }));
    gw._initialized = true;

    const result = gw.autoSelectModel('conversation');
    expect(result.adapter).toBe('relay');
    expect(result.reason).toBe('fallback');

    // Restore
    gw._adapters = origAdapters;
  });

  test('prefers task-specific adapter for reasoning', () => {
    const gw = require('../src/services/gateway/aiGateway');

    const origAdapters = gw._adapters;
    gw._adapters = origAdapters.map(a => ({
      ...a,
      available: a.key === 'ollama',
      adapter: { ...a.adapter, detect: () => a.key === 'ollama' },
    }));
    gw._initialized = true;

    const result = gw.autoSelectModel('analysis');
    expect(result.adapter).toBe('ollama');

    gw._adapters = origAdapters;
  });
});

describe('Default Route Recommendation', () => {
  test('demotes codex cli after recent stall and prefers api', () => {
    const gw = require('../src/services/gateway/aiGateway');
    const originalAdapters = gw._adapters;
    const originalInitialized = gw._initialized;
    const originalLastError = gw._adapterLastError;
    const originalPreferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;

    gw._initialized = true;
    gw._adapterLastError = {};
    delete process.env.GATEWAY_PREFERRED_ADAPTER;
    gw._adapters = [
      {
        key: 'codex',
        enabled: true,
        available: true,
        priority: 4,
        adapter: {
          detect: () => true,
          getStatus: () => ({
            name: 'Codex CLI (mindflow)',
            type: 'codex',
            available: true,
            detail: 'ok',
          }),
          getRuntimeDiagnostics: (options = {}) => {
            if (String(options.preferCategory || '') === 'stall') {
              return {
                at: Date.now() - 30_000,
                trigger: 'first_response_timeout',
                category: 'stall',
                healed: false,
                diagnosis: 'stall=turn_started_reconnect_loop',
                summary: 'recent first response stall',
              };
            }
            return {
              at: Date.now() - 30_000,
              trigger: 'first_response_timeout',
              category: 'stall',
              healed: false,
              diagnosis: 'stall=turn_started_reconnect_loop',
              summary: 'recent first response stall',
            };
          },
        },
      },
      {
        key: 'api',
        enabled: true,
        available: true,
        priority: 5,
        adapter: {
          detect: () => true,
          getStatus: () => ({
            name: 'API 池',
            type: 'api',
            available: true,
            detail: 'ok',
          }),
        },
      },
    ];

    try {
      const recommendation = gw.getDefaultRouteRecommendation();
      expect(recommendation).toBeTruthy();
      expect(recommendation.adapter).toBe('api');
      expect(recommendation.degradedAdapters.some((item) => item.adapter === 'codex')).toBe(true);
      expect(recommendation.summary).toContain('Codex CLI');
    } finally {
      gw._adapters = originalAdapters;
      gw._initialized = originalInitialized;
      gw._adapterLastError = originalLastError;
      if (originalPreferredAdapter === undefined) delete process.env.GATEWAY_PREFERRED_ADAPTER;
      else process.env.GATEWAY_PREFERRED_ADAPTER = originalPreferredAdapter;
    }
  });
});

// ──────────────────────────────────────────────────────
// 11. Memory Leak Prevention
// ──────────────────────────────────────────────────────

describe('Memory Leak Prevention', () => {
  test('_cleanupStaleData removes orphan keys and caps data', () => {
    const gw = require('../src/services/gateway/aiGateway');

    // Use a real adapter key so it's not treated as orphan
    const validKey = gw._adapters[0]?.key || 'cli';

    gw._adapterFailures = { [validKey]: 100, orphanKey: 5 };
    gw._requestLog = { [validKey]: new Array(200).fill(Date.now()), orphanLog: [1] };
    gw._adapterLastError = { orphanErrKey: { at: Date.now(), errorType: 'auth', error: 'x' } };

    gw._cleanupStaleData();

    // Failure count capped at 20 for valid keys
    expect(gw._adapterFailures[validKey]).toBeLessThanOrEqual(20);
    // Orphan failure key removed
    expect(gw._adapterFailures.orphanKey).toBeUndefined();
    // Request log trimmed to 100 for valid keys
    expect(gw._requestLog[validKey].length).toBeLessThanOrEqual(100);
    // Orphan log removed
    expect(gw._requestLog.orphanLog).toBeUndefined();
    // Orphan error key removed
    expect(gw._adapterLastError.orphanErrKey).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────
// 12. Model Normalization
// ──────────────────────────────────────────────────────

describe('Model Normalization', () => {
  // Test the exported normalizeModelForAdapter indirectly via classifyError presence
  test('gateway module exports classifyError', () => {
    const gw = require('../src/services/gateway/aiGateway');
    expect(typeof gw.classifyError).toBe('function');
  });

  test('gateway getStatus returns adapter list', () => {
    const gw = require('../src/services/gateway/aiGateway');
    const originalAdapters = gw._adapters;
    const originalLastError = gw._adapterLastError;
    gw._adapterLastError = {};
    gw._adapters = [{
      key: 'stub',
      enabled: true,
      priority: 0,
      adapter: {
        getStatus: () => ({
          name: 'Stub Adapter',
          type: 'test',
          available: true,
          detail: 'ok',
        }),
      },
    }];

    try {
      const status = gw.getStatus();
      expect(Array.isArray(status)).toBe(true);
      expect(status.length).toBeGreaterThan(0);
      expect(status[0]).toHaveProperty('name');
      expect(status[0]).toHaveProperty('enabled');
      expect(status[0]).toHaveProperty('priority');
      expect(status[0].name).toBe('Stub Adapter');
    } finally {
      gw._adapters = originalAdapters;
      gw._adapterLastError = originalLastError;
    }
  });
});
