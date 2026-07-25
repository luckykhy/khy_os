'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeCacheUsage, withCacheUsage } = require('../src/services/gateway/adapters/_cacheUsage');

test('Anthropic cache fields map to canonical read/write', () => {
  const out = normalizeCacheUsage({
    cache_read_input_tokens: 1200,
    cache_creation_input_tokens: 300,
  });
  assert.strictEqual(out.cacheReadInputTokens, 1200);
  assert.strictEqual(out.cacheWriteInputTokens, 300);
});

test('OpenAI prompt_tokens_details.cached_tokens maps to read (no write)', () => {
  const out = normalizeCacheUsage({
    prompt_tokens: 5000,
    prompt_tokens_details: { cached_tokens: 4096 },
  });
  assert.strictEqual(out.cacheReadInputTokens, 4096);
  assert.strictEqual(out.cacheWriteInputTokens, 0);
});

test('DeepSeek prompt_cache_hit_tokens maps to read', () => {
  const out = normalizeCacheUsage({ prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 });
  assert.strictEqual(out.cacheReadInputTokens, 800);
  assert.strictEqual(out.cacheWriteInputTokens, 0);
});

test('canonical names pass through untouched', () => {
  const out = normalizeCacheUsage({ cacheReadInputTokens: 999, cacheWriteInputTokens: 111 });
  assert.strictEqual(out.cacheReadInputTokens, 999);
  assert.strictEqual(out.cacheWriteInputTokens, 111);
});

test('canonical names take precedence over vendor variants', () => {
  const out = normalizeCacheUsage({
    cacheReadInputTokens: 500,
    cache_read_input_tokens: 999,
  });
  assert.strictEqual(out.cacheReadInputTokens, 500);
});

test('missing / empty usage yields zeros', () => {
  assert.deepStrictEqual(normalizeCacheUsage(null), { cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  assert.deepStrictEqual(normalizeCacheUsage({}), { cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  assert.deepStrictEqual(normalizeCacheUsage('nope'), { cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
});

test('negative / non-finite values are clamped to 0', () => {
  const out = normalizeCacheUsage({ cache_read_input_tokens: -5, cache_creation_input_tokens: NaN });
  assert.strictEqual(out.cacheReadInputTokens, 0);
  assert.strictEqual(out.cacheWriteInputTokens, 0);
});

test('withCacheUsage is a no-op when there are no cache fields', () => {
  const base = { inputTokens: 10, outputTokens: 5 };
  const out = withCacheUsage(base, { prompt_tokens: 10 });
  assert.deepStrictEqual(out, base);
});

test('withCacheUsage merges canonical cache fields onto the base usage', () => {
  const base = { inputTokens: 10, outputTokens: 5 };
  const out = withCacheUsage(base, { cache_read_input_tokens: 7 });
  assert.strictEqual(out.inputTokens, 10);
  assert.strictEqual(out.cacheReadInputTokens, 7);
  assert.strictEqual(out.cacheWriteInputTokens, 0);
});
