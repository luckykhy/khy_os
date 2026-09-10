'use strict';
const { normalizeCacheUsage, withCacheUsage } = require('../src/services/gateway/adapters/_cacheUsage');

describe('Cache Usage Normalizer', () => {
  test('Anthropic cache fields map to canonical read/write', () => {
      const out = normalizeCacheUsage({
        cache_read_input_tokens: 1200,
        cache_creation_input_tokens: 300,
      });
      expect(out.cacheReadInputTokens).toBe(1200);
      expect(out.cacheWriteInputTokens).toBe(300);
  });

  test('OpenAI prompt_tokens_details.cached_tokens maps to read (no write)', () => {
      const out = normalizeCacheUsage({
        prompt_tokens: 5000,
        prompt_tokens_details: { cached_tokens: 4096 },
      });
      expect(out.cacheReadInputTokens).toBe(4096);
      expect(out.cacheWriteInputTokens).toBe(0);
  });

  test('DeepSeek prompt_cache_hit_tokens maps to read', () => {
      const out = normalizeCacheUsage({ prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
      expect(out.cacheReadInputTokens).toBe(800);
      expect(out.cacheWriteInputTokens).toBe(0);
  });

  test('canonical names pass through untouched', () => {
      const out = normalizeCacheUsage({ cacheReadInputTokens: 999, cacheWriteInputTokens: 111 });
      expect(out.cacheReadInputTokens).toBe(999);
      expect(out.cacheWriteInputTokens).toBe(111);
  });

  test('canonical names take precedence over vendor variants', () => {
      const out = normalizeCacheUsage({
        cacheReadInputTokens: 500,
        cache_read_input_tokens: 999,
      });
      expect(out.cacheReadInputTokens).toBe(500);
  });

  test('missing / empty usage yields zeros', () => {
      expect(normalizeCacheUsage(null)).toBe({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
      expect(normalizeCacheUsage({})).toBe({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
      expect(normalizeCacheUsage('nope')).toBe({ cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  });

  test('negative / non-finite values are clamped to 0', () => {
      const out = normalizeCacheUsage({ cache_read_input_tokens: -5, cache_creation_input_tokens: NaN });
      expect(out.cacheReadInputTokens).toBe(0);
      expect(out.cacheWriteInputTokens).toBe(0);
  });

  test('withCacheUsage is a no-op when there are no cache fields', () => {
      const base = { inputTokens: 10, outputTokens: 5 };
      const out = withCacheUsage(base, { prompt_tokens: 10 });
      expect(out).toEqual(base);
  });

  test('withCacheUsage merges canonical cache fields onto the base usage', () => {
      const base = { inputTokens: 10, outputTokens: 5 };
      const out = withCacheUsage(base, { cache_read_input_tokens: 7 });
      expect(out.inputTokens).toBe(10);
      expect(out.cacheReadInputTokens).toBe(7);
      expect(out.cacheWriteInputTokens).toBe(0);
  });

});

