'use strict';

/**
 * System prompt section management with state-aware memoization.
 * Ported from Claude Code's systemPromptSections.ts architecture.
 *
 * Two types of sections:
 * - systemPromptSection(): Cached, but keyed by a caller-supplied cacheKey that
 *   reflects the real inputs the section depends on (cwd, model, language, ...).
 *   The cache holds at most one entry per id; when the cacheKey changes the
 *   section is recomputed. This mirrors s10's rule that the cache key must
 *   reflect real state — otherwise a closure that captured turn 1's cwd would
 *   be frozen and serve stale content after the user switches projects.
 * - DANGEROUS_uncachedSystemPromptSection(): Recomputes every turn.
 *
 * Cache invalidation is therefore automatic on input change; clearSectionCache()
 * additionally forces a full refresh (e.g. on /clear or /compact).
 */

// id -> { key: string|null, value: string|null }
const _sectionCache = new Map();

/**
 * Normalize an arbitrary cacheKey into a stable string (or null).
 * @param {*} cacheKey
 * @returns {string|null}
 */
function _normalizeKey(cacheKey) {
  if (cacheKey == null) return null;
  if (typeof cacheKey === 'string') return cacheKey;
  try {
    return JSON.stringify(cacheKey);
  } catch {
    return String(cacheKey);
  }
}

/**
 * Create a cached system prompt section.
 *
 * The compute function is memoized until the cacheKey changes. Pass a cacheKey
 * derived from every input the section reads (cwd, model, language, etc.).
 * Omitting it falls back to id-only caching — only safe for sections whose
 * output never depends on per-request state.
 *
 * @param {string} id - Unique section identifier
 * @param {Function} compute - Async or sync function that returns string|null
 * @param {*} [cacheKey] - Value(s) the section depends on; stringified for keying
 * @returns {{ id: string, compute: Function, cached: boolean, cacheKey: string|null }}
 */
function systemPromptSection(id, compute, cacheKey) {
  return { id, compute, cached: true, cacheKey: _normalizeKey(cacheKey) };
}

/**
 * Create an uncached system prompt section that recomputes every turn.
 * Use sparingly - breaks prompt caching.
 *
 * @param {string} id - Unique section identifier
 * @param {Function} compute - Async or sync function that returns string|null
 * @param {string} _reason - Why this section cannot be cached (for documentation)
 * @returns {{ id: string, compute: Function, cached: boolean, cacheKey: null }}
 */
function DANGEROUS_uncachedSystemPromptSection(id, compute, _reason) {
  return { id, compute, cached: false, cacheKey: null };
}

/**
 * Resolve all system prompt sections, using cache where possible.
 *
 * The cache holds one entry per section id. A cached entry is reused only when
 * its stored cacheKey matches the section's current cacheKey; otherwise the
 * section is recomputed and the entry replaced. This bounds the cache to one
 * value per id (no unbounded growth) while guaranteeing freshness on input
 * change.
 *
 * @param {Array<{ id: string, compute: Function, cached: boolean, cacheKey?: string|null }>} sections
 * @returns {Promise<string[]>} Resolved non-null section strings
 */
async function resolveSystemPromptSections(sections) {
  const results = [];

  for (const section of sections) {
    let value;

    if (section.cached) {
      const key = section.cacheKey ?? null;
      const entry = _sectionCache.get(section.id);
      if (entry && entry.key === key) {
        value = entry.value;
      } else {
        value = await section.compute();
        _sectionCache.set(section.id, { key, value });
      }
    } else {
      value = await section.compute();
    }

    if (value != null) {
      results.push(value);
    }
  }

  return results;
}

/**
 * Clear all cached sections (called on /clear or /compact).
 */
function clearSectionCache() {
  _sectionCache.clear();
}

module.exports = {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
  clearSectionCache,
};
