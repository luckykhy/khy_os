'use strict';

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { PromptCache } = require('../src/services/promptCacheService');

describe('promptCacheService', () => {
  let cache;

  beforeEach(() => {
    cache = new PromptCache({ maxEntries: 5, ttlMs: 500, maxBytes: 10 * 1024 * 1024 });
  });

  // ── computeKey ──

  describe('computeKey()', () => {
    test('returns consistent SHA-256 hash for same input', () => {
      const content = { systemPrompt: 'You are helpful.', tools: [{ name: 'read' }], model: 'gpt-4' };
      const key1 = cache.computeKey(content);
      const key2 = cache.computeKey(content);
      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64); // SHA-256 hex
    });

    test('returns different hashes for different content', () => {
      const key1 = cache.computeKey({ systemPrompt: 'Hello', tools: [], model: 'a' });
      const key2 = cache.computeKey({ systemPrompt: 'World', tools: [], model: 'a' });
      expect(key1).not.toBe(key2);
    });

    test('normalizes tool order for consistent hashing', () => {
      const key1 = cache.computeKey({
        systemPrompt: 'test',
        tools: [{ name: 'read' }, { name: 'write' }],
        model: 'x',
      });
      const key2 = cache.computeKey({
        systemPrompt: 'test',
        tools: [{ name: 'write' }, { name: 'read' }],
        model: 'x',
      });
      expect(key1).toBe(key2);
    });

    test('handles missing optional fields', () => {
      const key = cache.computeKey({});
      expect(key).toHaveLength(64);
    });
  });

  // ── put + get round-trip ──

  describe('put() and get()', () => {
    test('round-trip: put then get returns the same content', () => {
      const content = { systemPrompt: 'Hello', tools: [] };
      const key = cache.computeKey(content);
      cache.put(key, content);
      const retrieved = cache.get(key);
      expect(retrieved).toEqual(content);
    });

    test('get returns null for missing key', () => {
      expect(cache.get('nonexistent-key')).toBeNull();
    });

    test('put updates access stats for existing key', () => {
      const content = { systemPrompt: 'test' };
      const key = 'test-key';
      cache.put(key, content, 'agent-1');
      cache.put(key, content, 'agent-2');
      const summary = cache.getSummary();
      expect(summary.length).toBe(1);
      expect(summary[0].accessCount).toBe(2);
    });

    test('get tracks agentId in users list', () => {
      const key = 'agent-track';
      cache.put(key, { data: 'x' }, 'agent-a');
      cache.get(key, 'agent-b');
      // Verify through getSummary
      const summary = cache.getSummary();
      expect(summary[0].users).toBe(2);
    });
  });

  // ── TTL expiry ──

  describe('TTL expiry', () => {
    test('entry expires after TTL', async () => {
      const shortCache = new PromptCache({ maxEntries: 10, ttlMs: 50 });
      const key = 'ttl-test';
      shortCache.put(key, { prompt: 'hello' });

      expect(shortCache.get(key)).toBeTruthy();

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 80));

      expect(shortCache.get(key)).toBeNull();
    });
  });

  // ── LRU eviction ──

  describe('LRU eviction', () => {
    test('evicts least recently used entry when max entries exceeded', () => {
      // Cache has maxEntries = 5
      for (let i = 0; i < 5; i++) {
        cache.put(`key-${i}`, { data: `value-${i}` });
      }

      // Access key-0 to make it recently used
      cache.get('key-0');

      // Adding a 6th entry should evict the LRU (key-1, since key-0 was just accessed)
      cache.put('key-new', { data: 'new' });

      expect(cache.get('key-0')).toBeTruthy();
      expect(cache.get('key-new')).toBeTruthy();
      // One of keys 1-4 should have been evicted (the least recently used)
      const metrics = cache.getMetrics();
      expect(metrics.size).toBeLessThanOrEqual(5);
    });
  });

  // ── has() ──

  describe('has()', () => {
    test('returns true for existing non-expired entry', () => {
      cache.put('exists', { data: 'yes' });
      expect(cache.has('exists')).toBe(true);
    });

    test('returns false for missing entry', () => {
      expect(cache.has('nope')).toBe(false);
    });

    test('returns false after TTL expires', async () => {
      const shortCache = new PromptCache({ maxEntries: 10, ttlMs: 50 });
      shortCache.put('temp', { data: 'yes' });
      expect(shortCache.has('temp')).toBe(true);

      await new Promise((r) => setTimeout(r, 80));
      expect(shortCache.has('temp')).toBe(false);
    });
  });

  // ── invalidate ──

  describe('invalidate()', () => {
    test('removes a specific entry', () => {
      cache.put('to-remove', { data: 'bye' });
      expect(cache.has('to-remove')).toBe(true);
      cache.invalidate('to-remove');
      expect(cache.has('to-remove')).toBe(false);
      expect(cache.get('to-remove')).toBeNull();
    });

    test('is a no-op for nonexistent key', () => {
      expect(() => cache.invalidate('nonexistent')).not.toThrow();
    });
  });

  // ── invalidateAgent ──

  describe('invalidateAgent()', () => {
    test('removes entries only used by that agent', () => {
      cache.put('shared', { data: 'shared' }, 'agent-a');
      cache.get('shared', 'agent-b');  // Now used by both agents
      cache.put('solo-a', { data: 'solo' }, 'agent-a');

      cache.invalidateAgent('agent-a');

      // shared entry should still exist (agent-b still uses it)
      expect(cache.has('shared')).toBe(true);
      // solo-a should be removed (only agent-a used it)
      expect(cache.has('solo-a')).toBe(false);
    });

    test('does not remove entries used by other agents', () => {
      cache.put('multi', { data: 'multi' }, 'agent-x');
      cache.get('multi', 'agent-y');

      cache.invalidateAgent('agent-x');
      expect(cache.has('multi')).toBe(true);
    });
  });

  // ── getMetrics ──

  describe('getMetrics()', () => {
    test('returns correct hit/miss counts', () => {
      cache.put('m1', { data: 'a' });
      cache.get('m1');       // hit
      cache.get('m1');       // hit
      cache.get('missing');  // miss

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(2);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRate).toBe('66.7%');
    });

    test('returns correct size', () => {
      cache.put('a', { x: 1 });
      cache.put('b', { x: 2 });
      const metrics = cache.getMetrics();
      expect(metrics.size).toBe(2);
    });

    test('tracks eviction count', () => {
      cache.put('e1', { data: 'a' });
      cache.invalidate('e1');
      const metrics = cache.getMetrics();
      expect(metrics.evictions).toBe(1);
    });
  });

  // ── getSummary ──

  describe('getSummary()', () => {
    test('returns array with entry details', () => {
      cache.put('sum-1', { data: 'hello' }, 'agent-1');
      cache.put('sum-2', { data: 'world' });

      const summary = cache.getSummary();
      expect(Array.isArray(summary)).toBe(true);
      expect(summary.length).toBe(2);
      expect(summary[0]).toHaveProperty('key');
      expect(summary[0]).toHaveProperty('byteSize');
      expect(summary[0]).toHaveProperty('accessCount');
      expect(summary[0]).toHaveProperty('users');
      expect(summary[0]).toHaveProperty('ageSec');
    });

    test('returns empty array when cache is empty', () => {
      expect(cache.getSummary()).toEqual([]);
    });
  });

  // ── clear ──

  describe('clear()', () => {
    test('empties the entire cache', () => {
      cache.put('c1', { a: 1 });
      cache.put('c2', { b: 2 });
      cache.put('c3', { c: 3 });
      expect(cache.getMetrics().size).toBe(3);

      cache.clear();
      expect(cache.getMetrics().size).toBe(0);
      expect(cache.getMetrics().totalBytes).toBe(0);
      expect(cache.get('c1')).toBeNull();
    });
  });
});
