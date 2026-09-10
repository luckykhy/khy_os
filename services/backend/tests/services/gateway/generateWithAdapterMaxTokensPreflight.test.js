'use strict';
/**
 * generateWithAdapterMaxTokensPreflight.test.js (node:test)
 *
 * Locks the symmetric preflight max_tokens resolution on the direct-adapter
 * path (AIGatewayModelMethods.generateWithAdapter â€?used by IDE conversation
 * mode), which bypasses the generate() main loop and previously fell through
 * to small adapter hardcoded fallbacks when the caller passed no maxTokens.
 *
 * Pins:
 *   - no maxTokens + known context window â†?adapter receives a dynamically
 *     injected maxTokens (= min(maxOutput || available, window âˆ?prompt
 *     estimate âˆ?safety buffer)) plus a _maxTokensPolicy marker;
 *   - explicit maxTokens â†?passed through verbatim, no injection marker;
 *   - KHY_MAX_TOKENS_AUTO_RESOLVE=0 â†?no injection at all.
 *
 * Hermetic: stubs _generateWithAdapterIsolation to capture the options the
 * adapter would receive; prefills _contextWindowCache; no network calls.
 */
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

describe('Generate With Adapter Max Tokens Preflight', () => {
  test('no maxTokens + known window â†?injects dynamic maxTokens with policy marker', async () => {
      await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: undefined, KHY_DEFAULT_MAX_TOKENS: undefined }, async () => {
        await withStubbedGateway({ contextWindows: { 'unit-model-alpha': 32000 } }, async (captured) => {
          const prompt = 'hello preflight world';
          await gateway.generateWithAdapter('stub', prompt, { model: 'unit-model-alpha' });
          // Expected budget mirrors the policy: window âˆ?prompt estimate âˆ?buffer(512)
          const expected = 32000 - estimateTokens(prompt) - 512;
          expect(captured.options.maxTokens).toBe(expected);
          expect(captured.options._maxTokensPolicy).toBeTruthy();
          expect(captured.options._maxTokensPolicy.source).toBe('context_window');
          expect(captured.options._maxTokensPolicy.preflightMax).toBe(expected);
          expect(captured.options._maxTokensPolicy.shrunk).toBe(false);
        });
      });
  });

  test('no maxTokens + window + smaller output limit â†?caps at the output limit', async () => {
      await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: undefined, KHY_DEFAULT_MAX_TOKENS: undefined }, async () => {
        await withStubbedGateway({
          contextWindows: { 'unit-model-beta': 128000 },
          outputLimits: { 'unit-model-beta': 8192 },
        }, async (captured) => {
          await gateway.generateWithAdapter('stub', 'short prompt', { model: 'unit-model-beta' });
          expect(captured.options.maxTokens).toBe(8192);
          expect(captured.options._maxTokensPolicy.source).toBe('model_output_limit');
        });
      });
  });

  test('explicit maxTokens: 123 â†?passed through verbatim, no injection marker', async () => {
      await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: undefined }, async () => {
        await withStubbedGateway({ contextWindows: { 'unit-model-alpha': 32000 } }, async (captured) => {
          const callerOptions = { model: 'unit-model-alpha', maxTokens: 123 };
          await gateway.generateWithAdapter('stub', 'hi', callerOptions);
          expect(captured.options.maxTokens).toBe(123);
          expect(captured.options._maxTokensPolicy).toBe(undefined);
          // Caller object is passed as-is (no clone, no mutation) on this branch.
          expect(captured.options).toBe(callerOptions);
        });
      });
  });

  test('KHY_MAX_TOKENS_AUTO_RESOLVE=0 â†?no injection even with known window', async () => {
      await withEnv({ KHY_MAX_TOKENS_AUTO_RESOLVE: '0' }, async () => {
        await withStubbedGateway({ contextWindows: { 'unit-model-alpha': 32000 } }, async (captured) => {
          await gateway.generateWithAdapter('stub', 'hi', { model: 'unit-model-alpha' });
          expect(captured.options.maxTokens).toBe(undefined);
          expect(captured.options._maxTokensPolicy).toBe(undefined);
        });
      });
  });

});

