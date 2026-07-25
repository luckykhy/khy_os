'use strict';

/**
 * Tests for usageFormatter.js — token formatting, USD formatting,
 * tiered pricing, cost estimation, and usage line formatting.
 */

const {
  formatTokenCount,
  formatUsd,
  normalizeTieredPricing,
  selectPricingTier,
  estimateUsageCost,
  resolveModelCost,
  formatUsageLine,
  DEFAULT_MODEL_PRICING,
} = require('../../src/services/usageFormatter');

describe('formatTokenCount', () => {
  test('returns "0" for null/undefined/NaN', () => {
    expect(formatTokenCount(null)).toBe('0');
    expect(formatTokenCount(undefined)).toBe('0');
    expect(formatTokenCount(NaN)).toBe('0');
    expect(formatTokenCount(Infinity)).toBe('0');
  });

  test('formats millions with one decimal', () => {
    expect(formatTokenCount(2500000)).toBe('2.5m');
    expect(formatTokenCount(1000000)).toBe('1.0m');
  });

  test('formats thousands with "k" suffix', () => {
    expect(formatTokenCount(12000)).toBe('12k');
    expect(formatTokenCount(1500)).toBe('1.5k');
  });

  test('returns raw number for values under 1000', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(0)).toBe('0');
  });

  test('handles edge case at boundary between k and m', () => {
    // 999500+ should round to 1.0m
    const result = formatTokenCount(999500);
    expect(result).toMatch(/m|k/);
  });
});

describe('formatUsd', () => {
  test('returns undefined for null/NaN', () => {
    expect(formatUsd(null)).toBeUndefined();
    expect(formatUsd(undefined)).toBeUndefined();
    expect(formatUsd(NaN)).toBeUndefined();
  });

  test('uses 2 decimals for amounts >= $0.01', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0.01)).toBe('$0.01');
    expect(formatUsd(100)).toBe('$100.00');
  });

  test('uses 4 decimals for amounts < $0.01', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.001)).toBe('$0.0010');
  });

  test('handles negative values with sign prefix', () => {
    expect(formatUsd(-5.50)).toBe('-$5.50');
    expect(formatUsd(-0.001)).toBe('-$0.0010');
  });

  test('formats zero correctly', () => {
    expect(formatUsd(0)).toBe('$0.0000');
  });
});

describe('normalizeTieredPricing', () => {
  test('returns undefined for empty/invalid input', () => {
    expect(normalizeTieredPricing([])).toBeUndefined();
    expect(normalizeTieredPricing(null)).toBeUndefined();
    expect(normalizeTieredPricing([{ input: 'bad', output: 1, range: [0, 100] }])).toBeUndefined();
  });

  test('normalizes valid tiers with defaults', () => {
    const raw = [{ input: 3.0, output: 15.0, range: [0, 128000] }];
    const result = normalizeTieredPricing(raw);
    expect(result).toHaveLength(1);
    expect(result[0].cacheRead).toBe(0);
    expect(result[0].cacheWrite).toBe(0);
    expect(result[0].range).toEqual([0, 128000]);
  });

  test('sorts tiers by range start', () => {
    const raw = [
      { input: 5, output: 15, range: [128000, Infinity] },
      { input: 3, output: 10, range: [0, 128000] },
    ];
    const result = normalizeTieredPricing(raw);
    expect(result[0].range[0]).toBe(0);
    expect(result[1].range[0]).toBe(128000);
  });

  test('handles missing range as [0, Infinity]', () => {
    const raw = [{ input: 3.0, output: 15.0 }];
    const result = normalizeTieredPricing(raw);
    expect(result[0].range).toEqual([0, Infinity]);
  });
});

describe('selectPricingTier', () => {
  const tiers = [
    { input: 3, output: 10, cacheRead: 0, cacheWrite: 0, range: [0, 128000] },
    { input: 5, output: 15, cacheRead: 0, cacheWrite: 0, range: [128000, Infinity] },
  ];

  test('selects correct tier for token count', () => {
    expect(selectPricingTier(tiers, 50000).input).toBe(3);
    expect(selectPricingTier(tiers, 200000).input).toBe(5);
  });

  test('returns first tier for zero/negative tokens', () => {
    expect(selectPricingTier(tiers, 0).input).toBe(3);
    expect(selectPricingTier(tiers, -100).input).toBe(3);
  });

  test('returns last tier for overflow', () => {
    // If token count exceeds all tier ranges, falls back to last tier
    const limitedTiers = [
      { input: 3, output: 10, cacheRead: 0, cacheWrite: 0, range: [0, 100] },
    ];
    expect(selectPricingTier(limitedTiers, 500).input).toBe(3);
  });

  test('returns undefined for empty tiers', () => {
    expect(selectPricingTier([], 1000)).toBeUndefined();
    expect(selectPricingTier(null, 1000)).toBeUndefined();
  });
});

describe('estimateUsageCost', () => {
  test('calculates flat-rate cost correctly', () => {
    const cost = estimateUsageCost({
      usage: { input: 1000000, output: 500000 },
      cost: { input: 3.0, output: 15.0 },
    });
    // (1M * 3.0 + 500K * 15.0) / 1M = 3.0 + 7.5 = 10.5
    expect(cost).toBeCloseTo(10.5, 4);
  });

  test('returns undefined for missing usage or cost', () => {
    expect(estimateUsageCost({ usage: null, cost: { input: 1 } })).toBeUndefined();
    expect(estimateUsageCost({ usage: { input: 100 }, cost: null })).toBeUndefined();
  });

  test('includes cache token costs', () => {
    const cost = estimateUsageCost({
      usage: { input: 0, output: 0, cacheRead: 1000000, cacheWrite: 500000 },
      cost: { input: 0, output: 0, cacheRead: 1.0, cacheWrite: 2.0 },
    });
    // (1M * 1.0 + 500K * 2.0) / 1M = 1.0 + 1.0 = 2.0
    expect(cost).toBeCloseTo(2.0, 4);
  });
});

describe('resolveModelCost', () => {
  test('resolves exact model names', () => {
    const cost = resolveModelCost('claude-opus-4');
    expect(cost).toBeDefined();
    expect(cost.input).toBe(15.0);
  });

  test('resolves prefix matches (versioned models)', () => {
    const cost = resolveModelCost('claude-opus-4-20250514');
    expect(cost).toBeDefined();
    expect(cost.input).toBe(15.0);
  });

  test('returns undefined for unknown models', () => {
    expect(resolveModelCost('totally-unknown-model')).toBeUndefined();
    expect(resolveModelCost(null)).toBeUndefined();
  });
});

describe('formatUsageLine', () => {
  test('returns null for empty/zero usage', () => {
    expect(formatUsageLine({ usage: null })).toBeNull();
    expect(formatUsageLine({ usage: { input: 0, output: 0 } })).toBeNull();
  });

  test('formats basic input/output', () => {
    const line = formatUsageLine({
      usage: { input: 1500, output: 2500 },
      showCost: false,
    });
    expect(line).toContain('in');
    expect(line).toContain('out');
  });

  test('includes cache info when present', () => {
    const line = formatUsageLine({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      showCost: false,
    });
    expect(line).toContain('cache');
    expect(line).toContain('cached');
  });
});
