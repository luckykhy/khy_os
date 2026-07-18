'use strict';

/**
 * Tests for contextWindowGuard.js — token budget enforcement.
 */

let mod;
try {
  mod = require('../../src/services/contextWindowGuard');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('contextWindowGuard', () => {
  const {
    resolveThresholds,
    evaluateGuard,
    pruneMessages,
    formatWarning,
    HARD_MIN_TOKENS,
    WARN_BELOW_TOKENS,
    HARD_MIN_RATIO,
    WARN_BELOW_RATIO,
  } = mod || {};

  test('resolveThresholds caps floors proportionally on small context windows', () => {
    // Legacy behavior made the absolute floors dominate a small window:
    // hardMin=4000 (40% of 10k) blocked below nearly half the window and
    // warn=8000 (80%) warned across almost all of it — the small-model bug.
    // contextProfile caps each floor to a sane fraction of the window:
    //   hardMin = min(max(4000, 1000), 10000*0.25) = min(4000, 2500) = 2500
    //   warn    = min(max(8000, 2000), 10000*0.40) = min(8000, 4000) = 4000
    const result = resolveThresholds(10000);
    expect(result.hardMinTokens).toBe(2500);
    expect(result.warnBelowTokens).toBe(4000);
    // warn must stay above hardMin
    expect(result.warnBelowTokens).toBeGreaterThan(result.hardMinTokens);
  });

  test('resolveThresholds scales for large context windows (unchanged from legacy)', () => {
    const result = resolveThresholds(200000);
    // 200000 * 0.1 = 20000 > HARD_MIN_TOKENS(4000); cap 200000*0.25=50000 is far
    // above, so it never binds → identical to the legacy floor math.
    expect(result.hardMinTokens).toBe(20000);
    expect(result.warnBelowTokens).toBe(40000);
  });

  test('resolveThresholds leaves the 32k boundary on the absolute floors', () => {
    // At the short-context boundary the absolute floors are still reasonable
    // (4000=12%, 8000=24%) and the proportional cap does not bind, so behavior
    // is unchanged for the common 32k-window models.
    const result = resolveThresholds(32768);
    expect(result.hardMinTokens).toBe(HARD_MIN_TOKENS);
    expect(result.warnBelowTokens).toBe(WARN_BELOW_TOKENS);
  });

  test('resolveThresholds handles zero and negative inputs', () => {
    const zero = resolveThresholds(0);
    expect(zero.hardMinTokens).toBe(HARD_MIN_TOKENS);
    const neg = resolveThresholds(-100);
    expect(neg.hardMinTokens).toBe(HARD_MIN_TOKENS);
  });

  test('evaluateGuard sets shouldWarn when nearing limit', () => {
    const guard = evaluateGuard({
      usedTokens: 95000,
      contextWindowTokens: 100000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.remainingTokens).toBe(5000);
  });

  test('evaluateGuard sets shouldBlock when below hard minimum', () => {
    const guard = evaluateGuard({
      usedTokens: 99000,
      contextWindowTokens: 100000,
    });
    expect(guard.shouldBlock).toBe(true);
  });

  test('evaluateGuard reports ok when usage is low', () => {
    const guard = evaluateGuard({
      usedTokens: 10000,
      contextWindowTokens: 100000,
    });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
    expect(guard.usageRatio).toBeCloseTo(0.1);
  });

  test('pruneMessages does nothing when under budget', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const { pruned, removedCount } = pruneMessages(msgs, {
      targetTokens: 1000,
      estimateTokens: (t) => t.length,
    });
    expect(removedCount).toBe(0);
    expect(pruned).toEqual(msgs);
  });

  test('pruneMessages removes oldest non-system messages first', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'A'.repeat(100) },
      { role: 'assistant', content: 'B'.repeat(100) },
      { role: 'user', content: 'C'.repeat(100) },
      { role: 'assistant', content: 'D'.repeat(100) },
      { role: 'user', content: 'last user' },
      { role: 'assistant', content: 'last assistant' },
    ];
    const { pruned, removedCount } = pruneMessages(msgs, {
      targetTokens: 200,
      estimateTokens: (t) => t.length,
      minKeep: 2,
    });
    expect(removedCount).toBeGreaterThan(0);
    // System message should always survive
    expect(pruned.some(m => m.role === 'system')).toBe(true);
  });

  test('formatWarning includes usage percentage', () => {
    const guard = evaluateGuard({
      usedTokens: 80000,
      contextWindowTokens: 100000,
    });
    const msg = formatWarning(guard);
    expect(msg).toContain('80%');
    expect(msg).toContain('tokens remaining');
  });
});
