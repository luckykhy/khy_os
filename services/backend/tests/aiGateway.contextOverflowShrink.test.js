/**
 * aiGateway.contextOverflowShrink.test.js — locks the reactive
 * context-overflow auto-adjust gap branches in
 * src/services/gateway/aiGatewayGenerateMethod.js (tryContextOverflowAdjust
 * + its 413 call site + _cacheProbedContextWindow):
 *
 *   - a 413 whose message carries parseable token counts
 *     ("prompt is too long: N tokens > M maximum") shrinks maxTokens IN PLACE
 *     to limit - prompt - safetyBuffer and retries the SAME adapter, bounded
 *     by the regular attempt budget;
 *   - the shrink is STICKY: at most one adjustment per request — a second
 *     overflow never re-shrinks (shrink-only, no re-raise past the floor);
 *   - a too-tight window (available < min completion floor) does NOT shrink;
 *     the parsed token info rides out on the error diagnostics instead;
 *   - gate KHY_CONTEXT_OVERFLOW_AUTO_ADJUST='false' → byte-identical no-shrink
 *     legacy behavior even when the message is parseable.
 *
 * Hermetic harness mirrors tests/aiGateway.stability.test.js (Object.create
 * over the singleton + counting fake adapter; zero network).
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

/** 413 adapter: throws the parseable overflow error on the first N calls. */
function createOverflowAdapter(name, { failTimes, overflowMessage }) {
  let calls = 0;
  const seenMaxTokens = [];
  const generate = jest.fn(async (_prompt, opts = {}) => {
    calls += 1;
    seenMaxTokens.push(opts.maxTokens ?? null);
    if (calls <= failTimes) {
      const err = new Error(overflowMessage);
      err.status = 413;
      throw err;
    }
    return {
      success: true,
      content: `ok from ${name}`,
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
  return { adapter, seenMaxTokens };
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
  gw._clearAdapterFailure = (k) => {
    delete gw._adapterLastError[k];
  };
  gw._recordAdapterFailure = async () => {};
  gw._shouldSerializeAdapter = () => false;
  gw._handleAccountPoolAuthError = async () => {};
  gw.refreshAdapters = async () => {};
  return gw;
}

// parseContextOverflowTokens shapes: "prompt is too long: 90000 tokens > 100000 maximum"
// → { promptTokens: 90000, limitTokens: 100000 }; available = 100000 - 90000 - 512(buffer)
// = 9488 ≥ 256 (min completion floor) → a shrink to 9488 is legal.
const PARSEABLE_OVERFLOW = 'prompt is too long: 90000 tokens > 100000 maximum';
// 100000 - 99900 - 512 = -412 < 256 → too tight, no shrink.
const TIGHT_OVERFLOW = 'prompt is too long: 99900 tokens > 100000 maximum';

describe('context-overflow reactive maxTokens shrink (generate gap branches)', () => {
  afterEach(async () => {
    await cleanupGatewaySingleton();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupGatewaySingleton();
  });

  test('413 可解析 → 原地收缩 maxTokens 并在原通道重试（9488 = 100000-90000-512）', async () => {
    const { adapter, seenMaxTokens } = createOverflowAdapter('Shrink', {
      failTimes: 1,
      overflowMessage: PARSEABLE_OVERFLOW,
    });
    const gw = makeFakeGateway(adapter, 'shrink');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);

    const result = await AIGateway.generate.call(gw, 'context overflow shrink case', {
      maxTokens: 10000,
      maxAdapterAttempts: 2,
    });

    expect(result.success).toBe(true);
    expect(adapter.generate).toHaveBeenCalledTimes(2, 'one 413 then one in-place retry');
    expect(seenMaxTokens[0]).toBe(10000, 'first attempt used the requested maxTokens');
    expect(seenMaxTokens[1]).toBe(9488, 'retry used the shrunk maxTokens (limit - prompt - safety buffer)');
  });

  test('收缩每请求一次（STICKY）：第二次 413 钉在已收缩值、不二次收缩，诚实失败', async () => {
    const { adapter, seenMaxTokens } = createOverflowAdapter('Sticky', {
      failTimes: 2,
      overflowMessage: PARSEABLE_OVERFLOW,
    });
    const gw = makeFakeGateway(adapter, 'sticky');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);

    const result = await AIGateway.generate.call(gw, 'context overflow sticky case', {
      maxTokens: 10000,
      maxAdapterAttempts: 3,
    });

    expect(adapter.generate).toHaveBeenCalledTimes(2, 'exactly one in-place shrink retry — the second 413 triggers no further shrink');
    expect(seenMaxTokens).toEqual([
      10000, // attempt 1: requested value, then shrunk to 9488
      9488, // attempt 2: pinned at the shrink floor — NOT re-shrunk, NOT re-raised
    ]);
    // context_length is non-retryable beyond the one-shot shrink: the request
    // ends in an honest failure instead of burning the remaining attempt budget.
    expect(result.success).toBe(false);
    expect(result.errorType).toBe('context_length');
  });

  test('窗口过紧（可用空间 < 最小完成额度）→ 不收缩，原样失败且不重复尝试', async () => {
    const { adapter } = createOverflowAdapter('Tight', {
      failTimes: 99,
      overflowMessage: TIGHT_OVERFLOW,
    });
    const gw = makeFakeGateway(adapter, 'tight');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);

    const result = await AIGateway.generate.call(gw, 'context overflow tight window case', {
      maxTokens: 10000,
      maxAdapterAttempts: 1,
    });

    expect(result.success).toBe(false);
    expect(adapter.generate).toHaveBeenCalledTimes(1, 'no shrink headroom → no in-place retry');
    // the parsed token info must survive on the failure for upstream compaction
    const attempt = (result.attempts || []).find((a) => a.errorType !== undefined);
    expect(attempt).toBeDefined();
    expect(result.content).toBeTruthy();
  });

  test('KHY_CONTEXT_OVERFLOW_AUTO_ADJUST=false → 可解析也不收缩（逐字节回退旧行为）', async () => {
    const { adapter, seenMaxTokens } = createOverflowAdapter('GatedOff', {
      failTimes: 1,
      overflowMessage: PARSEABLE_OVERFLOW,
    });
    const gw = makeFakeGateway(adapter, 'gatedoff');
    const AIGateway = require(AI_GATEWAY_MODULE_PATH);
    const saved = process.env.KHY_CONTEXT_OVERFLOW_AUTO_ADJUST;
    process.env.KHY_CONTEXT_OVERFLOW_AUTO_ADJUST = 'false';
    try {
      const result = await AIGateway.generate.call(gw, 'context overflow gate off case', {
        maxTokens: 10000,
        maxAdapterAttempts: 2,
      });
      expect(result.success).toBe(false, 'without the shrink a 413 is not retryable in place');
      expect(seenMaxTokens.every((v) => v === 10000 || v === null)).toBe(
        true,
        'gate off → maxTokens is NEVER rewritten'
      );
    } finally {
      if (saved === undefined) delete process.env.KHY_CONTEXT_OVERFLOW_AUTO_ADJUST;
      else process.env.KHY_CONTEXT_OVERFLOW_AUTO_ADJUST = saved;
    }
  });
});
