'use strict';

/**
 * slugifyToken.js — single source of truth for turning an arbitrary token
 * (branch name, task id, cache key) into a filesystem-safe path segment.
 *
 * Three byte-identical private `_safe(s)` copies (evoEngine/evoLedger.js,
 * cognitiveSnapshot/offloadStore.js, cognitiveSnapshot/snapshotManager.js) each
 * built `path.join(dir, _safe(x) + '.json')` — i.e. this is the sanitizer that
 * keeps caller-supplied ids from injecting path separators / traversal / illegal
 * filename chars. Centralizing means that safety rule (and its length cap) lives
 * in exactly one place and hardens every caller at once.
 *
 * Contract: pure, deterministic, never throws.
 *   - nullish / empty `s` → the literal `'default'` (so a path segment always exists)
 *   - every char outside `[A-Za-z0-9_.-]` → `_` (drops `/`, `\`, `..` separators, spaces, unicode)
 *   - capped at 120 chars (bounded filename length)
 *
 * @param {*} s raw token (coerced via String)
 * @returns {string} a safe, non-empty path segment
 */
function slugifyToken(s) {
  return String(s || 'default').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

module.exports = slugifyToken;
