'use strict';

/**
 * generateWithAdapterMaxTokensPreflight.test.js (node:test)
 *
 * Locks the symmetric preflight max_tokens resolution on the direct-adapter
 * path (AIGatewayModelMethods.generateWithAdapter — used by IDE conversation
 * mode), which bypasses the generate() main loop and previously fell through
 * to small adapter hardcoded fallbacks when the caller passed no maxTokens.
 *
 * Pins:
 *   - no maxTokens + known context window → adapter receives a dynamically
 *     injected maxTokens (= min(maxOutput || available, window − prompt
 *     estimate − safety buffer)) plus a _maxTokensPolicy marker;
 *   - explicit maxTokens → passed through verbatim, no injection marker;
 *   - KHY_MAX_TOKENS_AUTO_RESOLVE=0 → no injection at all.
 *
 * Hermetic: stubs _generateWithAdapterIsolation to capture the options the
 * adapter would receive; prefills _contextWindowCache; no network calls.
 */

const test = require('node:test');
const assert = require('node:assert');

const gateway = require('../../../src/services/gateway/aiGateway');
const { estimateTokens } = require('../../../src/services/tokenPricing');

/**
 * Run fn with the gateway temporarily rewired: stub adapters list, capture
 * isolation-call options, and swap in fresh metadata caches. Everything is
 * restored in finally so the shared singleton stays pristine for other suites.
 */
async function withStubbedGateway({ contextWindows = {}, outputLimits = {} }, fn) {
  const saved = {
    adapters: gateway._adapters,
    isolation: gateway._generateWithAdapterIsolation,
    cwCache: gateway._contextWindowCache,
    outCache: gateway._modelOutputLimitCache,
  };
  const captured = { options: null, prompt: null };
  gateway._adapters = [{ key: 'stub', enabled: true, available: true, adapter: {} }];
  gateway._generateWithAdapterIsolation = async (entry, prompt, options) => {
    captured.prompt = prompt;
    captured.options = options;
    return { success: true, text: 'ok', provider: 'stub' };
  };
  gateway._contextWindowCache = new Map(Object.entries(contextWindows));
  gateway._modelOutputLimitCache = new Map(Object.entries(outputLimits));
  try {
    await fn(captured);
  } finally {
    gateway._adapters = saved.adapters;
    gateway._generateWithAdapterIsolation = saved.isolation;
    gateway._contextWindowCache = saved.cwCache;
    gateway._modelOutputLimitCache = saved.outCache;
  }
}

/** Run fn with select env vars overridden, restoring originals afterwards. */
async function withEnv(overrides, fn) {
  const savedEnv = {};
  for (const k of Object.keys(overrides)) {
    savedEnv[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

test('no maxTokens + known window → injects dynamic maxTokens with policy marker', async () => {
  await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: undefined, KHY_DEFAULT_MAX_TOKENS: undefined }, async () => {
    await withStubbedGateway({ contextWindows: { 'unit-model-alpha': 32000 } }, async (captured) => {
      const prompt = 'hello preflight world';
      await gateway.generateWithAdapter('stub', prompt, { model: 'unit-model-alpha' });
      // Expected budget mirrors the policy: window − prompt estimate − buffer(512)
      const expected = 32000 - estimateTokens(prompt) - 512;
      assert.strictEqual(captured.options.maxTokens, expected);
      assert.ok(captured.options._maxTokensPolicy, 'policy marker must be attached');
      assert.strictEqual(captured.options._maxTokensPolicy.source, 'context_window');
      assert.strictEqual(captured.options._maxTokensPolicy.preflightMax, expected);
      assert.strictEqual(captured.options._maxTokensPolicy.shrunk, false);
    });
  });
});

test('no maxTokens + window + smaller output limit → caps at the output limit', async () => {
  await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: undefined, KHY_DEFAULT_MAX_TOKENS: undefined }, async () => {
    await withStubbedGateway({
      contextWindows: { 'unit-model-beta': 128000 },
      outputLimits: { 'unit-model-beta': 8192 },
    }, async (captured) => {
      await gateway.generateWithAdapter('stub', 'short prompt', { model: 'unit-model-beta' });
      assert.strictEqual(captured.options.maxTokens, 8192);
      assert.strictEqual(captured.options._maxTokensPolicy.source, 'model_output_limit');
    });
  });
});

test('explicit maxTokens: 123 → passed through verbatim, no injection marker', async () => {
  await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: undefined }, async () => {
    await withStubbedGateway({ contextWindows: { 'unit-model-alpha': 32000 } }, async (captured) => {
      const callerOptions = { model: 'unit-model-alpha', maxTokens: 123 };
      await gateway.generateWithAdapter('stub', 'hi', callerOptions);
      assert.strictEqual(captured.options.maxTokens, 123);
      assert.strictEqual(captured.options._maxTokensPolicy, undefined);
      // Caller object is passed as-is (no clone, no mutation) on this branch.
      assert.strictEqual(captured.options, callerOptions);
    });
  });
});

test('KHY_MAX_TOKENS_AUTO_RESOLVE=0 → no injection even with known window', async () => {
  await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: '0' }, async () => {
    await withStubbedGateway({ contextWindows: { 'unit-model-alpha': 32000 } }, async (captured) => {
      await gateway.generateWithAdapter('stub', 'hi', { model: 'unit-model-alpha' });
      assert.strictEqual(captured.options.maxTokens, undefined);
      assert.strictEqual(captured.options._maxTokensPolicy, undefined);
    });
  });
});
