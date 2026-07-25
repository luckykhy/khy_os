'use strict';

/**
 * Tests for dedupeCache.js — TTL-based dedup cache with LRU eviction.
 */

const {
  createDedupeCache,
  resolveGlobalDedupeCache,
} = require('../../src/services/dedupeCache');

describe('createDedupeCache — check/peek', () => {
  test('first check returns false (new key)', () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 100 });
    expect(cache.check('key1')).toBe(false);
  });

  test('second check returns true (duplicate)', () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 100 });
    cache.check('key1');
    expect(cache.check('key1')).toBe(true);
  });

  test('peek does not mark key as seen', () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 100 });
    expect(cache.peek('key1')).toBe(false);
    expect(cache.peek('key1')).toBe(false); // still not seen
  });

  test('peek returns true for existing keys', () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 100 });
    cache.check('key1');
    expect(cache.peek('key1')).toBe(true);
  });

  test('check with falsy key always returns false', () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 100 });
    expect(cache.check('')).toBe(false);
    expect(cache.check(null)).toBe(false);
    expect(cache.check(undefined)).toBe(false);
  });
});

describe('createDedupeCache — TTL expiration', () => {
  test('expired key returns false (treated as new)', () => {
    const cache = createDedupeCache({ ttlMs: 100, maxSize: 100 });
    const now = 1000;
    cache.check('key1', now);
    // Check again after TTL
    expect(cache.check('key1', now + 200)).toBe(false);
  });

  test('key within TTL returns true (duplicate)', () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 100 });
    const now = 1000;
    cache.check('key1', now);
    expect(cache.check('key1', now + 500)).toBe(true);
  });
});

describe('createDedupeCache — LRU eviction', () => {
  test('evicts oldest entry when maxSize exceeded', () => {
    const cache = createDedupeCache({ ttlMs: 60000, maxSize: 3 });
    const now = 1000;
    cache.check('a', now);
    cache.check('b', now + 1);
    cache.check('c', now + 2);
    cache.check('d', now + 3); // should evict 'a'
    expect(cache.peek('a', now + 4)).toBe(false);
    expect(cache.peek('d', now + 4)).toBe(true);
  });

  test('size reflects current entry count', () => {
    const cache = createDedupeCache({ ttlMs: 60000, maxSize: 100 });
    expect(cache.size()).toBe(0);
    cache.check('a');
    cache.check('b');
    expect(cache.size()).toBe(2);
  });
});

describe('createDedupeCache — delete/clear', () => {
  test('delete removes a specific key', () => {
    const cache = createDedupeCache({ ttlMs: 60000, maxSize: 100 });
    cache.check('key1');
    cache.delete('key1');
    expect(cache.peek('key1')).toBe(false);
  });

  test('clear removes all keys', () => {
    const cache = createDedupeCache({ ttlMs: 60000, maxSize: 100 });
    cache.check('a');
    cache.check('b');
    cache.check('c');
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe('resolveGlobalDedupeCache', () => {
  test('returns same instance for same name', () => {
    const a = resolveGlobalDedupeCache('test-global-1', { ttlMs: 5000, maxSize: 10 });
    const b = resolveGlobalDedupeCache('test-global-1', { ttlMs: 5000, maxSize: 10 });
    expect(a).toBe(b);
  });

  test('returns different instances for different names', () => {
    const a = resolveGlobalDedupeCache('test-global-a', { ttlMs: 5000, maxSize: 10 });
    const b = resolveGlobalDedupeCache('test-global-b', { ttlMs: 5000, maxSize: 10 });
    expect(a).not.toBe(b);
  });
});
