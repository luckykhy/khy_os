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
      expect(cacheWarningEnabled({ KHY_CACHE_WARNING: 'true' })).toBe(true);
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
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '50' })).toBe(50);
    });

    test('returns default for out of range', () => {
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '0' })).toBe(80);
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '101' })).toBe(80);
      expect(getCacheThreshold({ KHY_CACHE_THRESHOLD: '-1' })).toBe(80);
    });

    test('returns default for invalid', () => {
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
      expect(calculateCacheHitRate(123)).toBeNull();
    });

    test('returns null when no cache data', () => {
      const usage = { inputTokens: 100, cacheWriteInputTokens: 0, cacheReadInputTokens: 0 };
      expect(calculateCacheHitRate(usage)).toBeNull();
    });

    test('returns null when total is 0', () => {
      const usage = { inputTokens: 0, cacheWriteInputTokens: 0, cacheReadInputTokens: 0 };
      expect(calculateCacheHitRate(usage)).toBeNull();
    });

    test('calculates hit rate correctly', () => {
      const usage = { inputTokens: 100, cacheWriteInputTokens: 50, cacheReadInputTokens: 80 };
      // total = 100 + 50 + 80 = 230, hit rate = 80/230 * 100 = 34.78...
      expect(calculateCacheHitRate(usage)).toBeCloseTo(34.78, 1);
    });

    test('returns 100 when all cache hits', () => {
      const usage = { inputTokens: 0, cacheWriteInputTokens: 0, cacheReadInputTokens: 100 };
      expect(calculateCacheHitRate(usage)).toBe(100);
    });

    test('returns 0 when no cache hits', () => {
      const usage = { inputTokens: 100, cacheWriteInputTokens: 50, cacheReadInputTokens: 0 };
      expect(calculateCacheHitRate(usage)).toBe(0);
    });

    test('handles CC snake_case field names', () => {
      const usage = { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 80 };
      expect(calculateCacheHitRate(usage)).toBeCloseTo(34.78, 1);
    });
  });

  describe('evaluateCacheWarning', () => {
    test('returns no warning when rate is null', () => {
      const result = evaluateCacheWarning({ hitRate: null, lastHitRate: null, threshold: 80 });
      expect(result.shouldWarn).toBe(false);
      expect(result.trend).toBeNull();
    });

    test('returns no warning when rate above threshold', () => {
      const result = evaluateCacheWarning({ hitRate: 90, lastHitRate: 85, threshold: 80 });
      expect(result.shouldWarn).toBe(false);
      expect(result.trend).toBe(5);
    });

    test('returns warning when rate below threshold', () => {
      const result = evaluateCacheWarning({ hitRate: 70, lastHitRate: 85, threshold: 80 });
      expect(result.shouldWarn).toBe(true);
      expect(result.trend).toBe(-15);
    });

    test('returns null trend on first observation', () => {
      const result = evaluateCacheWarning({ hitRate: 70, lastHitRate: null, threshold: 80 });
      expect(result.shouldWarn).toBe(true);
      expect(result.trend).toBeNull();
    });

    test('uses custom threshold', () => {
      const result = evaluateCacheWarning({ hitRate: 85, lastHitRate: 90, threshold: 90 });
      expect(result.shouldWarn).toBe(true);
    });
  });

  describe('buildCacheWarningLine', () => {
    test('builds basic warning line', () => {
      const result = buildCacheWarningLine({ hitRate: 70, threshold: 80 });
      expect(result).toContain('缓存命中率');
      expect(result).toContain('70%');
      expect(result).toContain('80%');
    });

    test('includes trend when significant', () => {
      const result = buildCacheWarningLine({ hitRate: 70, threshold: 80, trend: -5 });
      expect(result).toContain('↓');
      expect(result).toContain('5%');
    });

    test('includes up trend', () => {
      const result = buildCacheWarningLine({ hitRate: 70, threshold: 80, trend: 5 });
      expect(result).toContain('↑');
    });

    test('hides trend when insignificant', () => {
      const result = buildCacheWarningLine({ hitRate: 70, threshold: 80, trend: 0.05 });
      expect(result).not.toContain('↑');
      expect(result).not.toContain('↓');
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
      const result = cacheWarningFor({ usage: { inputTokens: 100, cacheReadInputTokens: 50 } }, {});
      expect(result.hitRate).toBeDefined();
      expect(result.text).toBeNull();
    });

    test('returns warning text when below threshold', () => {
      const result = cacheWarningFor({ usage: { inputTokens: 100, cacheReadInputTokens: 10 }, lastHitRate: 80 }, {});
      expect(result.text).toBeDefined();
      expect(result.text).toContain('缓存命中率');
    });
  });

  describe('sessionAggregateEnabled', () => {
    test('returns true by default', () => {
      expect(sessionAggregateEnabled({})).toBe(true);
    });

    test('returns false for off values', () => {
      expect(sessionAggregateEnabled({ KHY_CACHE_SESSION_AGGREGATE: '0' })).toBe(false);
      expect(sessionAggregateEnabled({ KHY_CACHE_SESSION_AGGREGATE: 'false' })).toBe(false);
    });
  });

  describe('accumulateSessionCache', () => {
    test('starts from zero', () => {
      const result = accumulateSessionCache(null, { inputTokens: 100, cacheReadInputTokens: 50 });
      expect(result.hit).toBe(50);
      expect(result.miss).toBe(100);
      expect(result.turns).toBe(1);
    });

    test('accumulates multiple turns', () => {
      const prev = { hit: 50, miss: 100, turns: 1 };
      const result = accumulateSessionCache(prev, { inputTokens: 100, cacheReadInputTokens: 80 });
      expect(result.hit).toBe(130);
      expect(result.miss).toBe(200);
      expect(result.turns).toBe(2);
    });

    test('skips turns with no cache data', () => {
      const prev = { hit: 50, miss: 100, turns: 1 };
      const result = accumulateSessionCache(prev, { inputTokens: 100, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
      expect(result.turns).toBe(1);
    });
  });

  describe('aggregateCacheRate', () => {
    test('returns null for no data', () => {
      expect(aggregateCacheRate({ hit: 0, miss: 0 })).toBeNull();
      expect(aggregateCacheRate({})).toBeNull();
      expect(aggregateCacheRate(null)).toBeNull();
    });

    test('calculates aggregate rate', () => {
      expect(aggregateCacheRate({ hit: 80, miss: 20 })).toBe(80);
      expect(aggregateCacheRate({ hit: 50, miss: 50 })).toBe(50);
    });
  });

  describe('buildSessionAggregateLine', () => {
    test('returns null for no data', () => {
      expect(buildSessionAggregateLine({ hit: 0, miss: 0 })).toBeNull();
      expect(buildSessionAggregateLine({})).toBeNull();
    });

    test('returns null for less than 1 turn', () => {
      expect(buildSessionAggregateLine({ hit: 80, miss: 20, turns: 0 })).toBeNull();
    });

    test('builds line with turns', () => {
      const result = buildSessionAggregateLine({ hit: 80, miss: 20, turns: 5 });
      expect(result).toContain('会话累计命中率');
      expect(result).toContain('80%');
      expect(result).toContain('5 轮');
    });
  });

  describe('sessionAggregateFor', () => {
    test('returns null when disabled', () => {
      const result = sessionAggregateFor({ usage: { inputTokens: 100 } }, { KHY_CACHE_SESSION_AGGREGATE: '0' });
      expect(result).toBeNull();
    });

    test('returns session with turns', () => {
      const result = sessionAggregateFor({ usage: { inputTokens: 100, cacheReadInputTokens: 50 } }, {});
      expect(result.session).toBeDefined();
      expect(result.rate).toBeDefined();
    });
  });

  describe('DEFAULT_CACHE_THRESHOLD', () => {
    test('is 80', () => {
      expect(DEFAULT_CACHE_THRESHOLD).toBe(80);
    });
  });
});
