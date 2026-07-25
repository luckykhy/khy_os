'use strict';

/**
 * worktreeName.js — pure worktree-name validation (zero-dependency leaf).
 *
 * Extracted from worktreeManager.js to break the
 * `worktreeManager.js ⇄ tools/_taskStore.js` require cycle (DESIGN-ARCH-020,
 * R3). Both the worktree manager (services layer) and the task store (tools
 * layer) need this validation; placing it in a neutral leaf lets both depend on
 * it in the same direction instead of requiring each other.
 *
 * The function is pure: no I/O, no module state, deterministic. Behavior is
 * identical to the original definition — this is a relocation, not a rewrite.
 */

/**
 * Validate a worktree branch/name for safe on-disk + git usage.
 *
 * Rules (path-traversal hardening, s18):
 *   - non-empty string, max 64 chars
 *   - only [a-zA-Z0-9._/-]
 *   - not '.' or '..'
 *   - no empty / '.' / '..' path segments
 *
 * @param {string} name
 * @returns {boolean} true if the name is safe to use
 */
function validateName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 64) return false;
  if (!/^[a-zA-Z0-9._/-]+$/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

module.exports = { validateName };
