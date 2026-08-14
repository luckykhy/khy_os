'use strict';

/**
 * Unit tests for memoryTier.js — the memory layering model (pure leaf).
 *
 * Covers the five-part user goal:
 *   1/2/3) tier classification (short_term / cross_session / permanent), from an
 *          explicit `tier`, derived from `type`, or the default;
 *   4)     decideUpdate — same-name supersede vs unchanged-body skip vs insert;
 *   5)     forget policy + isForgetEligible — permanent is immune, others age out;
 *          plus promote() and the KHY_MEMORY_TIERS env gate (off ⇒ eligible=true,
 *          byte-identical fallback behavior).
 *
 * Pure module: no disk, no module reset needed; we only toggle one env var.
 */

const T = require('../../src/services/memoryTier');

const SAVED = {};
beforeEach(() => { SAVED.flag = process.env.KHY_MEMORY_TIERS; delete process.env.KHY_MEMORY_TIERS; });
afterEach(() => {
  if (SAVED.flag === undefined) delete process.env.KHY_MEMORY_TIERS;
  else process.env.KHY_MEMORY_TIERS = SAVED.flag;
});

describe('memoryTier.classifyTier', () => {
  test('explicit valid tier wins over type', () => {
    expect(T.classifyTier({ tier: 'permanent', type: 'project' })).toBe(T.TIERS.PERMANENT);
    expect(T.classifyTier({ tier: 'short_term', type: 'user' })).toBe(T.TIERS.SHORT_TERM);
  });

  test('derives from type when no explicit tier', () => {
    expect(T.classifyTier({ type: 'user' })).toBe(T.TIERS.PERMANENT);
    expect(T.classifyTier({ type: 'feedback' })).toBe(T.TIERS.CROSS_SESSION);
    expect(T.classifyTier({ type: 'reference' })).toBe(T.TIERS.CROSS_SESSION);
    expect(T.classifyTier({ type: 'project' })).toBe(T.TIERS.CROSS_SESSION);
  });

  test('unknown / missing / invalid falls back to DEFAULT_TIER (cross_session)', () => {
    expect(T.classifyTier({})).toBe(T.DEFAULT_TIER);
    expect(T.classifyTier({ type: 'nonsense' })).toBe(T.DEFAULT_TIER);
    expect(T.classifyTier({ tier: 'garbage', type: 'project' })).toBe(T.TIERS.CROSS_SESSION);
    expect(T.classifyTier(null)).toBe(T.DEFAULT_TIER);
    expect(T.DEFAULT_TIER).toBe(T.TIERS.CROSS_SESSION);
  });

  test('accepts a bare tier string (case-insensitive)', () => {
    expect(T.classifyTier('PERMANENT')).toBe(T.TIERS.PERMANENT);
    expect(T.classifyTier('  cross_session ')).toBe(T.TIERS.CROSS_SESSION);
    expect(T.classifyTier('not-a-tier')).toBe(T.DEFAULT_TIER);
  });

  test('isPermanent / isShortTerm predicates', () => {
    expect(T.isPermanent({ type: 'user' })).toBe(true);
    expect(T.isPermanent({ type: 'project' })).toBe(false);
    expect(T.isShortTerm('short_term')).toBe(true);
    expect(T.isShortTerm({ type: 'feedback' })).toBe(false);
  });
});

describe('memoryTier.forgetPolicy', () => {
  test('permanent never auto-forgets', () => {
    const p = T.forgetPolicy('permanent');
    expect(p.autoForget).toBe(false);
    expect(p.expiresAtSessionEnd).toBe(false);
  });
  test('short_term expires at session end', () => {
    const p = T.forgetPolicy('short_term');
    expect(p.autoForget).toBe(true);
    expect(p.expiresAtSessionEnd).toBe(true);
  });
  test('cross_session ages out but survives the session', () => {
    const p = T.forgetPolicy('cross_session');
    expect(p.autoForget).toBe(true);
    expect(p.expiresAtSessionEnd).toBe(false);
  });
  test('invalid tier defaults to cross_session policy', () => {
    expect(T.forgetPolicy('garbage').autoForget).toBe(true);
    expect(T.forgetPolicy('garbage').expiresAtSessionEnd).toBe(false);
  });
});

describe('memoryTier.isForgetEligible + env gate', () => {
  test('when enabled: permanent immune, others eligible', () => {
    expect(T.isForgetEligible({ type: 'user' })).toBe(false);
    expect(T.isForgetEligible({ tier: 'permanent' })).toBe(false);
    expect(T.isForgetEligible({ type: 'project' })).toBe(true);
    expect(T.isForgetEligible({ tier: 'short_term' })).toBe(true);
  });

  test('when KHY_MEMORY_TIERS is off: everything eligible (byte-identical fallback)', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      process.env.KHY_MEMORY_TIERS = off;
      expect(T.isEnabled()).toBe(false);
      expect(T.isForgetEligible({ type: 'user' })).toBe(true);
      expect(T.isForgetEligible({ tier: 'permanent' })).toBe(true);
    }
  });

  test('isEnabled defaults on for unset / empty / other values', () => {
    expect(T.isEnabled()).toBe(true);
    process.env.KHY_MEMORY_TIERS = '1';
    expect(T.isEnabled()).toBe(true);
    process.env.KHY_MEMORY_TIERS = 'on';
    expect(T.isEnabled()).toBe(true);
  });
});

describe('memoryTier.decideUpdate', () => {
  test('insert when no existing', () => {
    const d = T.decideUpdate(null, { name: 'a', body: 'x', type: 'project' });
    expect(d.action).toBe('insert');
    expect(d.tier).toBe(T.TIERS.CROSS_SESSION);
  });

  test('skip when body unchanged (whitespace-insensitive)', () => {
    const d = T.decideUpdate(
      { name: 'a', body: 'hello   world', type: 'project' },
      { name: 'a', body: 'hello world', type: 'project' },
    );
    expect(d.action).toBe('skip');
  });

  test('supersede when same name but different body — keeps the more durable tier', () => {
    const d = T.decideUpdate(
      { name: 'pref', body: 'old', type: 'user' },          // permanent
      { name: 'pref', body: 'new info', type: 'feedback' }, // cross_session
    );
    expect(d.action).toBe('supersede');
    expect(d.tier).toBe(T.TIERS.PERMANENT); // more-durable wins (no downgrade)
  });

  test('insert when different topic', () => {
    const d = T.decideUpdate(
      { name: 'topic-a', body: 'aaa', type: 'project' },
      { name: 'topic-b', body: 'bbb', type: 'project' },
    );
    expect(d.action).toBe('insert');
  });

  test('reads content field when body absent', () => {
    const d = T.decideUpdate(
      { name: 'a', content: 'same', type: 'project' },
      { name: 'a', content: 'same', type: 'project' },
    );
    expect(d.action).toBe('skip');
  });
});

describe('memoryTier.promote', () => {
  test('walks short_term → cross_session → permanent, saturating at top', () => {
    expect(T.promote('short_term')).toBe(T.TIERS.CROSS_SESSION);
    expect(T.promote('cross_session')).toBe(T.TIERS.PERMANENT);
    expect(T.promote('permanent')).toBe(T.TIERS.PERMANENT);
  });
  test('invalid input promotes from the default tier', () => {
    expect(T.promote('garbage')).toBe(T.TIERS.PERMANENT); // default cross_session → permanent
  });
});
