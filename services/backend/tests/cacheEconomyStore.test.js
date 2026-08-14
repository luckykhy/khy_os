'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the data dir BEFORE requiring the store (getDataDir reads this env).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cache-econ-'));
process.env.KHY_PROJECT_DATA_HOME = TMP;

const store = require('../src/services/gateway/cacheEconomyStore');

test.beforeEach(() => {
  store._reset();
  delete process.env.GATEWAY_CACHE_ECONOMY_MIN_REQUESTS;
  delete process.env.GATEWAY_CACHE_ECONOMY_HITRATE_FLOOR;
});

test('cache-capable adapter that never discloses fields → opaque_suspected_gouging after K', () => {
  for (let i = 0; i < 7; i += 1) {
    store.record('relay-mute', { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
  }
  // Below K (default 8): not yet condemned.
  assert.strictEqual(store.getVerdict('relay-mute'), 'insufficient_data');
  store.record('relay-mute', { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
  assert.strictEqual(store.getVerdict('relay-mute'), 'opaque_suspected_gouging');
});

test('discloses fields with healthy hit rate → transparent_caching', () => {
  for (let i = 0; i < 8; i += 1) {
    store.record('claude-direct', {
      tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 700, cacheWriteInputTokens: 0 },
      family: 'claude',
    });
  }
  assert.strictEqual(store.getVerdict('claude-direct'), 'transparent_caching');
  assert.strictEqual(store.getReport().adapters['claude-direct'].hitRate, 0.7);
});

test('discloses fields but hit rate below floor → no_cache_benefit', () => {
  for (let i = 0; i < 8; i += 1) {
    store.record('cold', {
      tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 10, cacheWriteInputTokens: 0 },
      family: 'openai',
    });
  }
  assert.strictEqual(store.getVerdict('cold'), 'no_cache_benefit');
});

test('local family is never judged as gouging → not_cacheable', () => {
  for (let i = 0; i < 12; i += 1) {
    store.record('ollama', { tokenUsage: { inputTokens: 500 }, family: 'ollama' });
  }
  assert.strictEqual(store.getVerdict('ollama'), 'not_cacheable');
});

test('field presence with zero value still counts as disclosure (not gouging)', () => {
  for (let i = 0; i < 10; i += 1) {
    store.record('honest-zero', {
      tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 0 },
      family: 'openai',
    });
  }
  // Discloses the field (value 0) → not opaque; just no benefit.
  assert.strictEqual(store.getVerdict('honest-zero'), 'no_cache_benefit');
});

test('gouging alert fires exactly once (sticky alerted flag)', () => {
  const original = console.warn;
  let warnCount = 0;
  console.warn = () => { warnCount += 1; };
  try {
    for (let i = 0; i < 15; i += 1) {
      store.record('spammer', { tokenUsage: { inputTokens: 1000 }, family: 'relay' });
    }
  } finally {
    console.warn = original;
  }
  assert.strictEqual(warnCount, 1);
});

test('thresholds are env-tunable', () => {
  process.env.GATEWAY_CACHE_ECONOMY_MIN_REQUESTS = '3';
  store._reset();
  for (let i = 0; i < 3; i += 1) {
    store.record('quickjudge', { tokenUsage: { inputTokens: 100 }, family: 'relay' });
  }
  assert.strictEqual(store.getVerdict('quickjudge'), 'opaque_suspected_gouging');
});

test('state persists across a fresh getReport (synchronous JSON)', () => {
  for (let i = 0; i < 8; i += 1) {
    store.record('persisted', {
      tokenUsage: { inputTokens: 200, cacheReadInputTokens: 100 },
      family: 'claude',
    });
  }
  const report = store.getReport();
  assert.strictEqual(report.adapters.persisted.requests, 8);
  assert.strictEqual(report.adapters.persisted.totalCacheReadTokens, 800);
});
