'use strict';
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

describe('Cache Economy Store', () => {
  test('cache-capable adapter that never discloses fields â†?opaque_suspected_gouging after K', () => {
      for (let i = 0; i < 7; i += 1) {
        store.record('relay-mute', { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
      }
      // Below K (default 8): not yet condemned.
      expect(store.getVerdict('relay-mute')).toBe('insufficient_data');
      store.record('relay-mute', { tokenUsage: { inputTokens: 1000 }, family: 'relay openai' });
      expect(store.getVerdict('relay-mute')).toBe('opaque_suspected_gouging');
  });

  test('discloses fields with healthy hit rate â†?transparent_caching', () => {
      for (let i = 0; i < 8; i += 1) {
        store.record('claude-direct', {
          tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 700, cacheWriteInputTokens: 0 },
          family: 'claude',
        });
      }
      expect(store.getVerdict('claude-direct')).toBe('transparent_caching');
      expect(store.getReport().adapters['claude-direct'].hitRate).toBe(0.7);
  });

  test('discloses fields but hit rate below floor â†?no_cache_benefit', () => {
      for (let i = 0; i < 8; i += 1) {
        store.record('cold', {
          tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 10, cacheWriteInputTokens: 0 },
          family: 'openai',
        });
      }
      expect(store.getVerdict('cold')).toBe('no_cache_benefit');
  });

  test('local family is never judged as gouging â†?not_cacheable', () => {
      for (let i = 0; i < 12; i += 1) {
        store.record('ollama', { tokenUsage: { inputTokens: 500 }, family: 'ollama' });
      }
      expect(store.getVerdict('ollama')).toBe('not_cacheable');
  });

  test('field presence with zero value still counts as disclosure (not gouging)', () => {
      for (let i = 0; i < 10; i += 1) {
        store.record('honest-zero', {
          tokenUsage: { inputTokens: 1000, cacheReadInputTokens: 0 },
          family: 'openai',
        });
      }
      // Discloses the field (value 0) â†?not opaque; just no benefit.
      expect(store.getVerdict('honest-zero')).toBe('no_cache_benefit');
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
      expect(warnCount).toBe(1);
  });

  test('thresholds are env-tunable', () => {
      process.env.GATEWAY_CACHE_ECONOMY_MIN_REQUESTS = '3';
      store._reset();
      for (let i = 0; i < 3; i += 1) {
        store.record('quickjudge', { tokenUsage: { inputTokens: 100 }, family: 'relay' });
      }
      expect(store.getVerdict('quickjudge')).toBe('opaque_suspected_gouging');
  });

  test('state persists across a fresh getReport (synchronous JSON)', () => {
      for (let i = 0; i < 8; i += 1) {
        store.record('persisted', {
          tokenUsage: { inputTokens: 200, cacheReadInputTokens: 100 },
          family: 'claude',
        });
      }
      const report = store.getReport();
      expect(report.adapters.persisted.requests).toBe(8);
      expect(report.adapters.persisted.totalCacheReadTokens).toBe(800);
  });

});

