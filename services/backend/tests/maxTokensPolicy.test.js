'use strict';

/**
 * Tests for maxTokensPolicy.resolveMaxTokens — the unified dynamic max_tokens
 * decision (pure function, zero IO). Pins the four contract rules:
 *   1. Explicit value wins; provably-overflowing explicit values are safely
 *      clamped down to the available window (never raised).
 *   2. No explicit value + known window → derive min(outputLimit, available);
 *      abstain (null) when available < minCompletion.
 *   3. Unknown window + known model output limit → use the output limit.
 *   4. Everything unknown → abstain (null); never invent a large value.
 */

const assert = require('assert');

const { resolveMaxTokens } = require('../src/services/gateway/maxTokensPolicy');

describe('maxTokensPolicy.resolveMaxTokens', () => {
  describe('rule 1 — explicit value', () => {
    test('respects an explicit value that fits the window', () => {
      const r = resolveMaxTokens({
        explicitMaxTokens: 4000,
        promptTokenEstimate: 1000,
        contextWindow: 32000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, 4000);
      assert.strictEqual(r.source, 'explicit');
      assert.strictEqual(r.clamped, false);
    });

    test('respects an explicit value when the window is unknown', () => {
      const r = resolveMaxTokens({ explicitMaxTokens: 9000, contextWindow: 0 });
      assert.strictEqual(r.maxTokens, 9000);
      assert.strictEqual(r.source, 'explicit');
    });

    test('safely clamps an explicit value that overflows the window', () => {
      // available = 8000 - 4000 - 512 = 3488; explicit 6000 > 3488 → clamp
      const r = resolveMaxTokens({
        explicitMaxTokens: 6000,
        promptTokenEstimate: 4000,
        contextWindow: 8000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, 3488);
      assert.strictEqual(r.source, 'explicit_clamped');
      assert.strictEqual(r.clamped, true);
    });

    test('keeps the explicit value when the window is too tight to clamp usefully', () => {
      // available = 4000 - 3800 - 512 < minCompletion → keep explicit, no clamp
      const r = resolveMaxTokens({
        explicitMaxTokens: 6000,
        promptTokenEstimate: 3800,
        contextWindow: 4000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, 6000);
      assert.strictEqual(r.source, 'explicit');
      assert.strictEqual(r.clamped, false);
    });
  });

  describe('rule 2 — derive from known context window', () => {
    test('uses the available window when no output limit is known', () => {
      // available = 128000 - 10000 - 512 = 117488
      const r = resolveMaxTokens({
        promptTokenEstimate: 10000,
        contextWindow: 128000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, 117488);
      assert.strictEqual(r.source, 'context_window');
    });

    test('caps at the model output limit when it is smaller than available', () => {
      const r = resolveMaxTokens({
        promptTokenEstimate: 1000,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, 8192);
      assert.strictEqual(r.source, 'model_output_limit');
    });

    test('caps at available when the output limit exceeds it', () => {
      // available = 16000 - 10000 - 512 = 5488 < maxOutputTokens 64000
      const r = resolveMaxTokens({
        promptTokenEstimate: 10000,
        contextWindow: 16000,
        maxOutputTokens: 64000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, 5488);
      assert.strictEqual(r.source, 'context_window');
    });

    test('abstains (null) when available < minCompletion', () => {
      // available = 8000 - 7800 - 512 < 0 → no useful budget
      const r = resolveMaxTokens({
        promptTokenEstimate: 7800,
        contextWindow: 8000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      assert.strictEqual(r.maxTokens, null);
      assert.strictEqual(r.source, 'insufficient_window');
    });
  });

  describe('rule 3 — unknown window, known output limit', () => {
    test('uses the model output limit as-is', () => {
      const r = resolveMaxTokens({ contextWindow: 0, maxOutputTokens: 32000 });
      assert.strictEqual(r.maxTokens, 32000);
      assert.strictEqual(r.source, 'model_output_limit');
    });
  });

  describe('rule 4 — everything unknown', () => {
    test('abstains with null and never invents a value', () => {
      const r = resolveMaxTokens({});
      assert.strictEqual(r.maxTokens, null);
      assert.strictEqual(r.source, 'unknown');
      assert.strictEqual(r.clamped, false);
    });

    test('treats malformed inputs as unknown (fail-soft)', () => {
      const r = resolveMaxTokens({
        explicitMaxTokens: 'abc',
        contextWindow: -5,
        maxOutputTokens: NaN,
      });
      assert.strictEqual(r.maxTokens, null);
      assert.strictEqual(r.source, 'unknown');
    });
  });

  describe('rule 4 — centralized defaultFallback', () => {
    test('everything unknown + defaultFallback > 0 → uses the fallback value', () => {
      const r = resolveMaxTokens({ defaultFallback: 4096 });
      assert.strictEqual(r.maxTokens, 4096);
      assert.strictEqual(r.source, 'default_fallback');
      assert.strictEqual(r.clamped, false);
      assert.strictEqual(r.diagnostics.defaultFallback, 4096);
    });

    test('everything unknown + defaultFallback absent/0 → still abstains (null)', () => {
      const rAbsent = resolveMaxTokens({});
      assert.strictEqual(rAbsent.maxTokens, null);
      assert.strictEqual(rAbsent.source, 'unknown');
      const rZero = resolveMaxTokens({ defaultFallback: 0 });
      assert.strictEqual(rZero.maxTokens, null);
      assert.strictEqual(rZero.source, 'unknown');
    });

    test('insufficient_window abstain is NOT overridden by defaultFallback', () => {
      // available = 8000 - 7800 - 512 < minCompletion → abstain regardless of fallback
      const r = resolveMaxTokens({
        promptTokenEstimate: 7800,
        contextWindow: 8000,
        safetyBuffer: 512,
        minCompletion: 256,
        defaultFallback: 4096,
      });
      assert.strictEqual(r.maxTokens, null);
      assert.strictEqual(r.source, 'insufficient_window');
    });

    test('explicit value still wins over defaultFallback (Rule 1 priority)', () => {
      const r = resolveMaxTokens({ explicitMaxTokens: 9000, defaultFallback: 4096 });
      assert.strictEqual(r.maxTokens, 9000);
      assert.strictEqual(r.source, 'explicit');
    });
  });

  describe('diagnostics surface', () => {
    test('always returns a diagnostics object with the computed available budget', () => {
      const r = resolveMaxTokens({
        promptTokenEstimate: 100,
        contextWindow: 1000,
        safetyBuffer: 100,
        minCompletion: 256,
      });
      assert.ok(r.diagnostics && typeof r.diagnostics === 'object');
      assert.strictEqual(r.diagnostics.available, 800);
      assert.strictEqual(r.diagnostics.reason, 'preflight');
    });

    test('tags the length_recovery reason through', () => {
      const r = resolveMaxTokens({ reason: 'length_recovery' });
      assert.strictEqual(r.diagnostics.reason, 'length_recovery');
    });
  });
});
