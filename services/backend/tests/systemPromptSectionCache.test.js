'use strict';

/**
 * Tests for the s10 fix: state-aware system-prompt section caching.
 *
 * The section cache holds one entry per section id. Before this fix it was
 * keyed by id ALONE, so a cached section that captured turn 1's cwd/model in a
 * closure was frozen for the process lifetime — switching projects or models
 * served stale prompt content. The fix keys each cache entry by a caller-supplied
 * cacheKey derived from the section's real inputs; a key change forces recompute,
 * while the cache stays bounded to one value per id.
 */

const assert = require('assert');

const {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
  clearSectionCache,
} = require('../src/constants/systemPromptSections');

describe('s10 — state-aware section cache', () => {
  beforeEach(() => clearSectionCache());

  test('same id + same cacheKey ⇒ computed once (cache hit)', async () => {
    let calls = 0;
    const make = () => systemPromptSection('env', () => { calls++; return 'v'; }, 'cwd=/a|model=opus');

    await resolveSystemPromptSections([make()]);
    await resolveSystemPromptSections([make()]);

    assert.strictEqual(calls, 1, 'second resolve with identical key must hit cache');
  });

  test('same id + changed cacheKey ⇒ recompute (staleness fixed)', async () => {
    const seen = [];
    const sectionFor = (cwd) =>
      systemPromptSection('env', () => { const v = `cwd:${cwd}`; seen.push(v); return v; }, `cwd=${cwd}`);

    const a = await resolveSystemPromptSections([sectionFor('/projectA')]);
    const b = await resolveSystemPromptSections([sectionFor('/projectB')]);

    assert.deepStrictEqual(a, ['cwd:/projectA']);
    assert.deepStrictEqual(b, ['cwd:/projectB'], 'switching cwd must not serve stale content');
    assert.deepStrictEqual(seen, ['cwd:/projectA', 'cwd:/projectB']);
  });

  test('cache holds at most one entry per id (no unbounded growth)', async () => {
    let calls = 0;
    const sectionFor = (k) => systemPromptSection('env', () => { calls++; return `v${k}`; }, `k=${k}`);

    // Alternate keys: each switch should recompute (proving old key was evicted).
    await resolveSystemPromptSections([sectionFor(1)]); // compute v1
    await resolveSystemPromptSections([sectionFor(2)]); // compute v2 (evicts v1)
    await resolveSystemPromptSections([sectionFor(1)]); // recompute v1 (was evicted)

    assert.strictEqual(calls, 3, 'an evicted key must be recomputed, not resurrected');
  });

  test('uncached section recomputes every resolve', async () => {
    let calls = 0;
    const make = () => DANGEROUS_uncachedSystemPromptSection('mcp', () => { calls++; return 'm'; }, 'volatile');

    await resolveSystemPromptSections([make()]);
    await resolveSystemPromptSections([make()]);

    assert.strictEqual(calls, 2);
  });

  test('null section values are dropped from the result', async () => {
    const out = await resolveSystemPromptSections([
      systemPromptSection('present', () => 'here', 'k'),
      systemPromptSection('absent', () => null, 'k'),
    ]);
    assert.deepStrictEqual(out, ['here']);
  });

  test('object cacheKeys are stringified deterministically', async () => {
    let calls = 0;
    const make = () => systemPromptSection('obj', () => { calls++; return 'v'; }, { model: 'opus', cwd: '/a' });

    await resolveSystemPromptSections([make()]);
    await resolveSystemPromptSections([make()]);

    assert.strictEqual(calls, 1, 'equal object keys must serialize to the same string');
  });

  test('clearSectionCache forces a full refresh', async () => {
    let calls = 0;
    const make = () => systemPromptSection('env', () => { calls++; return 'v'; }, 'stable');

    await resolveSystemPromptSections([make()]);
    clearSectionCache();
    await resolveSystemPromptSections([make()]);

    assert.strictEqual(calls, 2);
  });
});
