'use strict';

/**
 * Unit tests for sessionMemory.js — short-term within-session memory (layer 1)
 * and its forget-at-session-end semantics (point 5, short-term side).
 *
 * Covers: remember (insert / supersede same-name / skip unchanged), recall
 * ranking by relevance + recency, buildSection framing, size/list snapshot,
 * clear() forgetting, and the KHY_SESSION_MEMORY env gate. The store is an
 * in-process singleton, so each test starts from a cleared store.
 */

const SM = require('../../src/services/memoryEngine/sessionMemory');

const SAVED = {};
beforeEach(() => {
  SAVED.flag = process.env.KHY_SESSION_MEMORY;
  delete process.env.KHY_SESSION_MEMORY;
  SM.clear();
});
afterEach(() => {
  SM.clear();
  if (SAVED.flag === undefined) delete process.env.KHY_SESSION_MEMORY;
  else process.env.KHY_SESSION_MEMORY = SAVED.flag;
});

describe('sessionMemory.remember', () => {
  test('inserts a new short-term memory tagged short_term', () => {
    const r = SM.remember({ name: 'deploy plan', content: 'use docker compose for staging' });
    expect(r.success).toBe(true);
    expect(r.action).toBe('insert');
    expect(r.entry.tier).toBe(SM_TIER());
    expect(SM.size()).toBe(1);
  });

  test('supersedes a same-name memory in place (information update), not stacking', () => {
    SM.remember({ name: 'deploy plan', content: 'old: use a single VM' });
    const r = SM.remember({ name: 'deploy plan', content: 'new: use docker compose' });
    expect(r.action).toBe('supersede');
    expect(SM.size()).toBe(1);
    expect(SM.list()[0].content).toBe('new: use docker compose');
  });

  test('skips when body is unchanged (whitespace-insensitive)', () => {
    SM.remember({ name: 'note', content: 'hello world' });
    const r = SM.remember({ name: 'note', content: '  hello   world ' });
    expect(r.action).toBe('skip');
    expect(SM.size()).toBe(1);
  });

  test('rejects empty name / content', () => {
    expect(SM.remember({ name: '', content: 'x' }).success).toBe(false);
    expect(SM.remember({ name: 'x', content: '' }).success).toBe(false);
  });

  test('disabled by KHY_SESSION_MEMORY=off', () => {
    process.env.KHY_SESSION_MEMORY = 'off';
    expect(SM.isEnabled()).toBe(false);
    expect(SM.remember({ name: 'a', content: 'b' }).success).toBe(false);
  });
});

describe('sessionMemory.recall', () => {
  test('ranks by keyword relevance, filtering out the irrelevant', () => {
    SM.remember({ name: 'docker deploy', content: 'deploy the service with docker compose and nginx' });
    SM.remember({ name: 'lunch', content: 'remember to eat a sandwich' });
    const hits = SM.recall('how do we deploy with docker');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].name).toBe('docker deploy');
    expect(hits.map((h) => h.name)).not.toContain('lunch');
  });

  test('respects the limit option and recency tiebreak with empty query', () => {
    SM.remember({ name: 'a', content: 'alpha' });
    SM.remember({ name: 'b', content: 'beta' });
    SM.remember({ name: 'c', content: 'gamma' });
    const hits = SM.recall('', { limit: 2 });
    expect(hits.length).toBe(2);
    // Most recently added first under recency tiebreak.
    expect(hits[0].name).toBe('c');
  });

  test('empty store recalls nothing', () => {
    expect(SM.recall('anything')).toEqual([]);
  });
});

describe('sessionMemory.buildSection', () => {
  test('frames recalled short-term memories with a session-scoped header', () => {
    SM.remember({ name: 'api base url', content: 'staging api is at api.staging.example' });
    const section = SM.buildSection('what is the api base url');
    expect(section).toMatch(/\[SESSION_MEMORY\]/);
    expect(section).toMatch(/本次会话/);
    expect(section).toContain('api base url');
  });

  test('returns null when nothing relevant', () => {
    SM.remember({ name: 'x', content: 'totally unrelated content here' });
    expect(SM.buildSection('zzz qqq wholly different topic')).toBeNull();
    expect(SM.buildSection('anything')).not.toBeUndefined();
  });
});

describe('sessionMemory.clear — forget at session end', () => {
  test('clear() forgets all and returns the count', () => {
    SM.remember({ name: 'a', content: 'aaa' });
    SM.remember({ name: 'b', content: 'bbb' });
    expect(SM.size()).toBe(2);
    expect(SM.clear()).toBe(2);
    expect(SM.size()).toBe(0);
    expect(SM.list()).toEqual([]);
  });
});

// Helper: the canonical short_term tier value, sourced from memoryTier.
function SM_TIER() {
  return require('../../src/services/memoryTier').TIERS.SHORT_TERM;
}
