'use strict';

/**
 * Tests for maxTokensPolicy.resolveMaxTokens â€?the unified dynamic max_tokens
 * decision (pure function, zero IO). Pins the four contract rules:
 *   1. Explicit value wins; provably-overflowing explicit values are safely
 *      clamped down to the available window (never raised).
 *   2. No explicit value + known window â†?derive min(outputLimit, available);
 *      abstain (null) when available < minCompletion.
 *   3. Unknown window + known model output limit â†?use the output limit.
 *   4. Everything unknown â†?abstain (null); never invent a large value.
 */

const assert = require('assert');

const { resolveMaxTokens } = require('../src/services/gateway/maxTokensPolicy');

describe('maxTokensPolicy.resolveMaxTokens', () => {
  describe('rule 1 â€?explicit value', () => {
    test('respects an explicit value that fits the window', () => {
      const r = resolveMaxTokens({
        explicitMaxTokens: 4000,
        promptTokenEstimate: 1000,
        contextWindow: 32000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      expect(r.maxTokens).toBe(4000);
      expect(r.source).toBe('explicit');
      expect(r.clamped).toBe(false);
    });

    test('respects an explicit value when the window is unknown', () => {
      const r = resolveMaxTokens({ explicitMaxTokens: 9000, contextWindow: 0 });
      expect(r.maxTokens).toBe(9000);
      expect(r.source).toBe('explicit');
    });

    test('safely clamps an explicit value that overflows the window', () => {
      // available = 8000 - 4000 - 512 = 3488; explicit 6000 > 3488 â†?clamp
      const r = resolveMaxTokens({
        explicitMaxTokens: 6000,
        promptTokenEstimate: 4000,
        contextWindow: 8000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      expect(r.maxTokens).toBe(3488);
      expect(r.source).toBe('explicit_clamped');
      expect(r.clamped).toBe(true);
    });

    test('keeps the explicit value when the window is too tight to clamp usefully', () => {
      // available = 4000 - 3800 - 512 < minCompletion â†?keep explicit, no clamp
      const r = resolveMaxTokens({
        explicitMaxTokens: 6000,
        promptTokenEstimate: 3800,
        contextWindow: 4000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      expect(r.maxTokens).toBe(6000);
      expect(r.source).toBe('explicit');
      expect(r.clamped).toBe(false);
    });
  });

  describe('rule 2 â€?derive from known context window', () => {
    test('uses the available window when no output limit is known', () => {
      // available = 128000 - 10000 - 512 = 117488
      const r = resolveMaxTokens({
        promptTokenEstimate: 10000,
        contextWindow: 128000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      expect(r.maxTokens).toBe(117488);
      expect(r.source).toBe('context_window');
    });

    test('caps at the model output limit when it is smaller than available', () => {
      const r = resolveMaxTokens({
        promptTokenEstimate: 1000,
        contextWindow: 128000,
        maxOutputTokens: 8192,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      expect(r.maxTokens).toBe(8192);
      expect(r.source).toBe('model_output_limit');
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
      expect(r.maxTokens).toBe(5488);
      expect(r.source).toBe('context_window');
    });

    test('abstains (null) when available < minCompletion', () => {
      // available = 8000 - 7800 - 512 < 0 â†?no useful budget
      const r = resolveMaxTokens({
        promptTokenEstimate: 7800,
        contextWindow: 8000,
        safetyBuffer: 512,
        minCompletion: 256,
      });
      expect(r.maxTokens).toBe(null);
      expect(r.source).toBe('insufficient_window');
    });
  });

  describe('rule 3 â€?unknown window, known output limit', () => {
    test('uses the model output limit as-is', () => {
      const r = resolveMaxTokens({ contextWindow: 0, maxOutputTokens: 32000 });
      expect(r.maxTokens).toBe(32000);
      expect(r.source).toBe('model_output_limit');
    });
  });

  describe('rule 4 â€?everything unknown', () => {
    test('abstains with null and never invents a value', () => {
      const r = resolveMaxTokens({});
      expect(r.maxTokens).toBe(null);
      expect(r.source).toBe('unknown');
      expect(r.clamped).toBe(false);
    });

    test('treats malformed inputs as unknown (fail-soft)', () => {
      const r = resolveMaxTokens({
        explicitMaxTokens: 'abc',
        contextWindow: -5,
        maxOutputTokens: NaN,
      });
      expect(r.maxTokens).toBe(null);
      expect(r.source).toBe('unknown');
    });
  });

  describe('rule 4 â€?centralized defaultFallback', () => {
    test('everything unknown + defaultFallback > 0 â†?uses the fallback value', () => {
      const r = resolveMaxTokens({ defaultFallback: 4096 });
      expect(r.maxTokens).toBe(4096);
      expect(r.source).toBe('default_fallback');
      expect(r.clamped).toBe(false);
      expect(r.diagnostics.defaultFallback).toBe(4096);
    });

    test('everything unknown + defaultFallback absent/0 â†?still abstains (null)', () => {
      const rAbsent = resolveMaxTokens({});
      expect(rAbsent.maxTokens).toBe(null);
      expect(rAbsent.source).toBe('unknown');
      const rZero = resolveMaxTokens({ defaultFallback: 0 });
      expect(rZero.maxTokens).toBe(null);
      expect(rZero.source).toBe('unknown');
    });

    test('insufficient_window abstain is NOT overridden by defaultFallback', () => {
      // available = 8000 - 7800 - 512 < minCompletion â†?abstain regardless of fallback
      const r = resolveMaxTokens({
        promptTokenEstimate: 7800,
        contextWindow: 8000,
        safetyBuffer: 512,
        minCompletion: 256,
        defaultFallback: 4096,
      });
      expect(r.maxTokens).toBe(null);
      expect(r.source).toBe('insufficient_window');
    });

    test('explicit value still wins over defaultFallback (Rule 1 priority)', () => {
      const r = resolveMaxTokens({ explicitMaxTokens: 9000, defaultFallback: 4096 });
      expect(r.maxTokens).toBe(9000);
      expect(r.source).toBe('explicit');
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
      expect(r.diagnostics && typeof r.diagnostics === 'object').toBeTruthy();
      expect(r.diagnostics.available).toBe(800);
      expect(r.diagnostics.reason).toBe('preflight');
    });

    test('tags the length_recovery reason through', () => {
      const r = resolveMaxTokens({ reason: 'length_recovery' });
      expect(r.diagnostics.reason).toBe('length_recovery');
    });
  });
});

