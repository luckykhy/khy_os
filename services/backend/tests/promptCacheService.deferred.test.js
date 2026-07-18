'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { PromptCache } = require('../src/services/promptCacheService');

describe('promptCacheService — deferred invalidation', () => {
  let cache;
  let tmpFile;

  beforeEach(() => {
    cache = new PromptCache({ ttlMs: 60_000 });
    tmpFile = path.join(os.tmpdir(), `prompt-cache-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ok */ }
  });

  function putTestEntry(key, content, count) {
    cache.put(key, content || { systemPrompt: key });
    // Simulate multiple accesses
    for (let i = 1; i < (count || 1); i++) {
      cache.get(key);
    }
  }

  // ── Deferred invalidation ────────────────────────────────────────

  test('invalidateDeferred marks entry but get() still returns content', () => {
    const key = cache.computeKey({ systemPrompt: 'test-deferred' });
    cache.put(key, { systemPrompt: 'test-deferred' });

    cache.invalidateDeferred(key);

    // Entry should still be accessible this session
    const result = cache.get(key);
    expect(result).not.toBeNull();
    expect(result.systemPrompt).toBe('test-deferred');
  });

  test('invalidate() defaults to deferred (entry still accessible)', () => {
    const key = cache.computeKey({ systemPrompt: 'test-default' });
    cache.put(key, { systemPrompt: 'test-default' });

    cache.invalidate(key); // default = deferred

    expect(cache.get(key)).not.toBeNull();
  });

  test('invalidate(key, { immediate: true }) evicts immediately', () => {
    const key = cache.computeKey({ systemPrompt: 'test-immediate' });
    cache.put(key, { systemPrompt: 'test-immediate' });

    cache.invalidate(key, { immediate: true });

    expect(cache.get(key)).toBeNull();
  });

  test('invalidateNow() evicts immediately', () => {
    const key = cache.computeKey({ systemPrompt: 'test-now' });
    cache.put(key, { systemPrompt: 'test-now' });

    cache.invalidateNow(key);

    expect(cache.get(key)).toBeNull();
  });

  // ── Persistence interaction ──────────────────────────────────────

  test('persistToDisk skips entries with pending invalidation', () => {
    const key1 = cache.computeKey({ systemPrompt: 'keep-me' });
    const key2 = cache.computeKey({ systemPrompt: 'drop-me' });

    putTestEntry(key1, { systemPrompt: 'keep-me' }, 3);
    putTestEntry(key2, { systemPrompt: 'drop-me' }, 3);

    cache.invalidateDeferred(key2);

    const count = cache.persistToDisk(tmpFile, 1);

    // Only 1 entry should be persisted (key2 skipped)
    expect(count).toBe(1);

    const data = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    expect(data.entries.length).toBe(1);
    expect(data.entries[0].key).toBe(key1);
  });

  test('loadFromDisk does not restore deferred-invalidated entries (they were never persisted)', () => {
    const key = cache.computeKey({ systemPrompt: 'volatile' });
    putTestEntry(key, { systemPrompt: 'volatile' }, 3);
    cache.invalidateDeferred(key);
    cache.persistToDisk(tmpFile, 1);

    // Create a fresh cache and load
    const fresh = new PromptCache({ ttlMs: 60_000 });
    const loaded = fresh.loadFromDisk(tmpFile);

    expect(loaded).toBe(0); // nothing was persisted
    expect(fresh.get(key)).toBeNull();
  });

  // ── getProtectedKeys ─────────────────────────────────────────────

  test('getProtectedKeys returns high-frequency recent entries', () => {
    const key1 = cache.computeKey({ systemPrompt: 'frequent' });
    const key2 = cache.computeKey({ systemPrompt: 'rare' });

    putTestEntry(key1, { systemPrompt: 'frequent' }, 5); // 5 accesses
    putTestEntry(key2, { systemPrompt: 'rare' }, 1);      // 1 access

    const protected_ = cache.getProtectedKeys({ minAccess: 3, maxAgeSec: 600 });
    expect(protected_).toContain(key1);
    expect(protected_).not.toContain(key2);
  });

  test('getProtectedKeys excludes deferred-invalidated entries', () => {
    const key = cache.computeKey({ systemPrompt: 'deferred-but-hot' });
    putTestEntry(key, { systemPrompt: 'deferred-but-hot' }, 10);
    cache.invalidateDeferred(key);

    const protected_ = cache.getProtectedKeys();
    expect(protected_).not.toContain(key);
  });

  // ── invalidateAgent still works ──────────────────────────────────

  test('invalidateAgent removes agent from entry users', () => {
    const key = cache.computeKey({ systemPrompt: 'shared' });
    cache.put(key, { systemPrompt: 'shared' }, 'agent-a');
    cache.put(key, { systemPrompt: 'shared' }, 'agent-b');

    cache.invalidateAgent('agent-a');

    // Entry still exists (used by agent-b)
    expect(cache.get(key)).not.toBeNull();
  });
});
