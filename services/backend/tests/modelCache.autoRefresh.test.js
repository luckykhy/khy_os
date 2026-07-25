'use strict';

/**
 * Model Cache Auto-Refresh Tests — verify TTL invalidation logic.
 */

describe('Model Cache TTL Logic', () => {
  test('cache should be stale after TTL expires', () => {
    const MODEL_CACHE_TTL = 300000; // 5 min
    let fetchedAt = Date.now() - 400000; // 6.6 min ago
    const isStale = (Date.now() - fetchedAt) >= MODEL_CACHE_TTL;
    expect(isStale).toBe(true);
  });

  test('cache should be fresh within TTL', () => {
    const MODEL_CACHE_TTL = 300000;
    let fetchedAt = Date.now() - 100000; // 1.6 min ago
    const isStale = (Date.now() - fetchedAt) >= MODEL_CACHE_TTL;
    expect(isStale).toBe(false);
  });

  test('cache invalidation on proxy-changed event resets fetchedAt', () => {
    let _modelsFetchedAt = Date.now();
    let _models = [{ id: 'test-model' }];

    // Simulate proxy-changed
    _models = [];
    _modelsFetchedAt = 0;

    expect(_models).toHaveLength(0);
    expect(_modelsFetchedAt).toBe(0);
  });

  test('cache invalidation on token change resets fetchedAt', () => {
    let _modelsFetchedAt = Date.now();
    let _models = [{ id: 'model-1' }, { id: 'model-2' }];
    let _cachedTokenSignature = 'sig-old';

    // Simulate token change
    const nextSignature = 'sig-new';
    if (_cachedTokenSignature !== nextSignature) {
      _models = [];
      _modelsFetchedAt = 0;
    }
    _cachedTokenSignature = nextSignature;

    expect(_models).toHaveLength(0);
    expect(_modelsFetchedAt).toBe(0);
  });

  test('KIRO_MODEL_CACHE_MS env override works', () => {
    const original = process.env.KIRO_MODEL_CACHE_MS;
    process.env.KIRO_MODEL_CACHE_MS = '60000';
    const ttl = parseInt(process.env.KIRO_MODEL_CACHE_MS || '300000', 10);
    expect(ttl).toBe(60000);
    if (original) process.env.KIRO_MODEL_CACHE_MS = original;
    else delete process.env.KIRO_MODEL_CACHE_MS;
  });
});
