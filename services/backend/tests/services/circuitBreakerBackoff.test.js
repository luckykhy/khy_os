'use strict';

/**
 * circuitBreakerBackoff.test.js — Phase C-4 of the CB-SSP redesign (design doc §4.C).
 *
 * C-4 collapses three inline re-implementations of exponential backoff into the
 * single canonical `circuitBreaker.computeBackoffMs`. These tests assert:
 *   1. Mathematical shape: backoff = min(maxMs, baseMs · m^clamp(attempt,0,maxSteps)).
 *   2. Monotonic non-decreasing in attempt; saturates at the cap and the step bound.
 *   3. Byte-for-byte EQUIVALENCE to the two gateway formulas it replaced, across
 *      the full input range — this is the zero-regression proof for the delegation.
 *   4. Defaults sourced from DEFAULTS (multiplier 2, cap 300000) — no magic number.
 */

const { computeBackoffMs, DEFAULTS } = require('../../src/services/circuitBreaker');

describe('computeBackoffMs: canonical shape', () => {
  test('attempt 0 returns the base (no escalation)', () => {
    expect(computeBackoffMs({ baseMs: 1000, attempt: 0 })).toBe(1000);
  });

  test('doubles per attempt with the default multiplier (2)', () => {
    expect(computeBackoffMs({ baseMs: 1000, attempt: 1, maxMs: Infinity })).toBe(2000);
    expect(computeBackoffMs({ baseMs: 1000, attempt: 3, maxMs: Infinity })).toBe(8000);
  });

  test('monotone non-decreasing in attempt', () => {
    let prev = -1;
    for (let a = 0; a <= 12; a++) {
      const v = computeBackoffMs({ baseMs: 500, attempt: a, maxMs: Infinity });
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test('saturates at maxMs', () => {
    expect(computeBackoffMs({ baseMs: 1000, attempt: 100, maxMs: 5000 })).toBe(5000);
  });

  test('maxSteps bounds the exponent', () => {
    // attempt 10 but capped at 4 steps → 1000 · 2^4 = 16000
    expect(computeBackoffMs({ baseMs: 1000, attempt: 10, maxSteps: 4, maxMs: Infinity })).toBe(16000);
  });

  test('defaults come from DEFAULTS — no inline magic numbers', () => {
    // With no maxMs override, the cap is DEFAULTS.maxResetTimeoutMs (300000).
    expect(computeBackoffMs({ baseMs: 1e9, attempt: 1 })).toBe(DEFAULTS.maxResetTimeoutMs);
    expect(DEFAULTS.backoffMultiplier).toBe(2);
  });

  test('hardens against bad input (negative base, non-finite multiplier)', () => {
    expect(computeBackoffMs({ baseMs: -5, attempt: 2 })).toBe(0);
    expect(computeBackoffMs({ baseMs: 1000, attempt: 1, multiplier: NaN, maxMs: Infinity })).toBe(2000);
    expect(computeBackoffMs()).toBe(0);
  });
});

describe('equivalence to the replaced gateway formulas (zero-regression proof)', () => {
  test('cooldown escalation: == min(300000, max(base,floor)·2^min(over,4))', () => {
    const FLOOR = 30000;
    for (const cooldownMs of [5000, 30000, 90000]) {
      for (let over = 0; over <= 8; over++) {
        const legacy = Math.min(
          300000,
          Math.max(cooldownMs, FLOOR) * Math.pow(2, Math.min(over, 4)),
        );
        const unified = computeBackoffMs({
          baseMs: Math.max(cooldownMs, FLOOR),
          attempt: over,
          maxSteps: 4,
          maxMs: 300000,
        });
        expect(unified).toBe(legacy);
      }
    }
  });

  test('rate-limit pre-retry: == min(cap, base·2^(failures-1))', () => {
    for (const base of [250, 1000]) {
      for (const cap of [1800, 10000]) {
        for (let failures = 1; failures <= 9; failures++) {
          const legacy = Math.min(cap, base * Math.pow(2, failures - 1));
          const unified = computeBackoffMs({ baseMs: base, attempt: failures - 1, maxMs: cap });
          expect(unified).toBe(legacy);
        }
      }
    }
  });

  test("breaker's own half-open re-open: == min(maxReset, current·2)", () => {
    let current = DEFAULTS.resetTimeoutMs;
    for (let probe = 0; probe < 6; probe++) {
      const legacy = Math.min(current * DEFAULTS.backoffMultiplier, DEFAULTS.maxResetTimeoutMs);
      const unified = computeBackoffMs({
        baseMs: current,
        attempt: 1,
        multiplier: DEFAULTS.backoffMultiplier,
        maxMs: DEFAULTS.maxResetTimeoutMs,
      });
      expect(unified).toBe(legacy);
      current = unified;
    }
  });
});
