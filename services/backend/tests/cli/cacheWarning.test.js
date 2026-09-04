'use strict';

const {
  cacheWarningEnabled,
  getCacheThreshold,
  calculateCacheHitRate,
  evaluateCacheWarning,
  buildCacheWarningLine,
  cacheWarningFor,
  sessionAggregateEnabled,
  accumulateSessionCache,
  aggregateCacheRate,
  buildSessionAggregateLine,
  sessionAggregateFor,
  DEFAULT_CACHE_THRESHOLD,
} = require('../../src/cli/cacheWarning');

describe('cacheWarning', () => {
  describe('cacheWarningEnabled', () => {
    test('returns true by default', () => {
      expect(cacheWarningEnabled({})).toBe(true);
    });

    test('returns true for non-off values', () => {
      expect(cacheWarningEnabled({ KHY_CACHE_WARNING: '1' })).toBe(true);
    });

    test('returns false for off values', () => {
      expect(cacheWarningEnabled({ KHY_CACHE_WARNING: '0' })).toBe(false);
      expect(cacheWarningEnabled({ KHY_CACHE_WARNING: 'false' })).toBe(false);
      expect(cacheWarningEnabled({ KHY_CACHE_WARNING: 'off' })).toBe(false);
      expect(cacheWarningEnabled({ KHY_CACHE_WARNING: 'no' })).toBe(false);
    });
  });

  describe('getCacheThreshold', () => {
    test('returns default 80', () => {
      expect(getCacheThreshold({})).toBe(80);
    });

    test('returns custom threshold', () => {
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '90' })).toBe(90);
    });

    test('clamps to range 1-100', () => {
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '0' })).toBe(80);
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '101' })).toBe(80);
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '-10' })).toBe(80);
    });

    test('returns default for non-numeric', () => {
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: 'abc' })).toBe(80);
    });
  });

  describe('calculateCacheHitRate', () => {
    test('returns null for null/undefined', () => {
      expect(calculateCacheHitRate(null)).toBeNull();
      expect(calculateCacheHitRate(undefined)).toBeNull();
    });

    test('returns null for non-object', () => {
      expect(calculateCacheHitRate('string')).toBeNull();
    });

    test('returns null when no cache data', () => {
      const usage = { inputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
      expect(calculateCacheHitRate(usage)).toBeNull();
    });

    test('calculates hit rate correctly', () => {
      const usage = { inputTokens: 100, cacheReadInputTokens: 80, cacheWriteInputTokens: 20 };
      const rate = calculateCacheHitRate(usage);
      expect(rate).toBeCloseTo(80);
    });

    test('handles all cache hit', () => {
      const usage = { inputTokens: 0, cacheReadInputTokens: 100, cacheWriteInputTokens: 0 };
      const rate = calculateCacheHitRate(usage);
      expect(rate).toBe(100);
    });

    test('handles zero input', () => {
      const usage = { inputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 100 };
      expect(calculateCacheHitRate(usage)).toBeNull();
    });

    test('supports snake_case fields', () => {
      const usage = { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 };
      const rate = calculateCacheHitRate(usage);
      expect(rate).toBeCloseTo(80);
    });
  });

  describe('evaluateCacheWarning', () => {
    test('returns no warning when rate is null', () => {
      const result = evaluateCacheWarning({ hitRate: null, lastHitRate: null, threshold: 80 });
      expect(result.shouldWarn).toBe(false);
      expect(result.trend).toBeNull();
    });

    test('returns warning when below threshold', () => {
      const result = evaluateCacheWarning({ hitRate: 70, lastHitRate: 75, threshold: 80 });
      expect(result.shouldWarn).toBe(true);
      expect(result.trend).toBe(-5);
    });

    test('returns no warning when above threshold', () => {
      const result = evaluateCacheWarning({ hitRate: 90, lastHitRate: 85, threshold: 80 });
      expect(result.shouldWarn).toBe(false);
      expect(result.trend).toBe(5);
    });

    test('returns null trend for first observation', () => {
      const result = evaluateCacheWarning({ hitRate: 70, lastHitRate: null, threshold: 80 });
      expect(result.trend).toBeNull();
    });

    test('uses default threshold', () => {
      const result = evaluateCacheWarning({ hitRate: 70, lastHitRate: 75 });
      expect(result.shouldWarn).toBe(true);
    });
  });

  describe('buildCacheWarningLine', () => {
    test('builds warning line', () => {
      const line = buildCacheWarningLine({ hitRate: 70, threshold: 80, trend: -5 });
      expect(line).toContain('70%');
      expect(line).toContain('80%');
      expect(line).toContain('↓');
    });

    test('shows upward trend', () => {
      const line = buildCacheWarningLine({ hitRate: 70, threshold: 80, trend: 5 });
      expect(line).toContain('↑');
    });

    test('hides trend when small', () => {
      const line = buildCacheWarningLine({ hitRate: 70, threshold: 80, trend: 0.05 });
      expect(line).not.toContain('↑');
      expect(line).not.toContain('↓');
    });
  });

  describe('cacheWarningFor', () => {
    test('returns null when disabled', () => {
      const result = cacheWarningFor({ usage: { inputTokens: 100 } }, { KHY_CACHE_WARNING: '0' });
      expect(result).toBeNull();
    });

    test('returns null when no cache data', () => {
      const result = cacheWarningFor({ usage: { inputTokens: 100 } }, {});
      expect(result).toBeNull();
    });

    test('returns hitRate on first observation', () => {
      const result = cacheWarningFor({ usage: { inputTokens: 100, cacheReadInputTokens: 80, cacheWriteInputTokens: 20 } }, {});
      expect(result).not.toBeNull();
      expect(result.hitRate).toBeDefined();
      expect(result.text).toBeNull();
    });

    test('returns warning when below threshold', () => {
      const result = cacheWarningFor({ usage: { inputTokens: 100, cacheReadInputTokens: 50, cacheWriteInputTokens: 50 }, lastHitRate: 90 }, {});
      expect(result.text).not.toBeNull();
      expect(result.text).toContain('缓存命中率');
    });
  });

  describe('sessionAggregateEnabled', () => {
    test('returns true by default', () => {
      expect(sessionAggregateEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(sessionAggregateEnabled({ KHY_CACHE_SESSION_AGGREGATE: '0' })).toBe(false);
    });
  });

  describe('accumulateSessionCache', () => {
    test('starts from zero', () => {
      const result = accumulateSessionCache(null, { inputTokens: 100, cacheReadInputTokens: 80, cacheWriteInputTokens: 20 });
      expect(result.hit).toBe(80);
      expect(result.miss).toBe(120);
      expect(result.turns).toBe(1);
    });

    test('accumulates multiple turns', () => {
      const prev = { hit: 80, miss: 120, turns: 1 };
      const result = accumulateSessionCache(prev, { inputTokens: 100, cacheReadInputTokens: 90, cacheWriteInputTokens: 10 });
      expect(result.hit).toBe(170);
      expect(result.miss).toBe(230);
      expect(result.turns).toBe(2);
    });

    test('skips turns with no cache data', () => {
      const prev = { hit: 80, miss: 120, turns: 1 };
      const result = accumulateSessionCache(prev, { inputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
      expect(result.turns).toBe(1);
    });
  });

  describe('aggregateCacheRate', () => {
    test('returns null for empty session', () => {
      expect(aggregateCacheRate(null)).toBeNull();
      expect(aggregateCacheRate({ hit: 0, miss: 0 })).toBeNull();
    });

    test('calculates aggregate rate', () => {
      const session = { hit: 80, miss: 20 };
      expect(aggregateCacheRate(session)).toBe(80);
    });
  });

  describe('buildSessionAggregateLine', () => {
    test('returns null for empty session', () => {
      expect(buildSessionAggregateLine(null)).toBeNull();
      expect(buildSessionAggregateLine({ hit: 0, miss: 0, turns: 0 })).toBeNull();
    });

    test('builds aggregate line', () => {
      const line = buildSessionAggregateLine({ hit: 80, miss: 20, turns: 5 });
      expect(line).toContain('80%');
      expect(line).toContain('5 轮');
    });
  });

  describe('sessionAggregateFor', () => {
    test('returns null when disabled', () => {
      const result = sessionAggregateFor({ usage: { inputTokens: 100 } }, { KHY_CACHE_SESSION_AGGREGATE: '0' });
      expect(result).toBeNull();
    });

    test('returns null for first turn', () => {
      const result = sessionAggregateFor({ usage: { inputTokens: 100, cacheReadInputTokens: 80, cacheWriteInputTokens: 20 } }, {});
      expect(result).not.toBeNull();
      expect(result.text).toBeNull();
    });

    test('returns text for second turn', () => {
      const session = { hit: 80, miss: 120, turns: 1 };
      const result = sessionAggregateFor({ session, usage: { inputTokens: 100, cacheReadInputTokens: 90, cacheWriteInputTokens: 10 } }, {});
      expect(result.text).not.toBeNull();
    });
  });

  describe('DEFAULT_CACHE_THRESHOLD', () => {
    test('is 80', () => {
      expect(DEFAULT_CACHE_THRESHOLD).toBe(80);
    });
  });
});
