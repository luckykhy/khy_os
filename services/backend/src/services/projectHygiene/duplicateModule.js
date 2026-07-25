'use strict';

/**
 * projectHygiene/duplicateModule.js — deterministic "is this new file a
 * re-implementation of one that already exists?" check ([DESIGN-ARCH-054],
 * rule 2). One capability should live in exactly one place; a second parallel
 * module (utils2.js, a copy-pasted helper, a second auth layer) is the detour
 * this guards against.
 *
 * Three independent signals, strongest match wins. All conservative — the
 * guard only converts a hit into an *approvable* block, so a false positive
 * costs one keystroke, while a miss lets duplication through. Tuned to flag
 * obvious clones, not coincidental overlap.
 */

const path = require('path');
const { extractSymbols, symbolOverlap, extOf } = require('./symbols');
const {
  dupSymbolOverlap,
  dupContentJaccard,
  dupMinSymbols,
} = require('./thresholds');

// Tokens that turn an existing name into a "version 2 / copy" of it. A sibling
// whose stem reduces to the same base as the new file is a name-duplicate.
const VERSION_TOKENS = /(copy|clone|new|old|bak|backup|final|tmp|temp|draft|v\d+|\d+)$/i;

/** Normalize a file's basename to a comparison stem: lowercase, drop ext, drop
 * separators, then peel trailing version/copy tokens. `userService2.js` and
 * `user-service.js` both reduce to `userservice`. */
function nameStem(filePath) {
  let base = path.basename(String(filePath || ''));
  base = base.replace(/\.[A-Za-z0-9]+$/, '');           // drop extension
  let stem = base.toLowerCase().replace(/[\s_.-]/g, ''); // fold separators
  // Peel one or more trailing version/copy tokens off the ORIGINAL (separated)
  // form so "user_service_v2" → "userservice", but keep peeling conservatively.
  let prev;
  let parts = base.toLowerCase().split(/[\s_.-]+/).filter(Boolean);
  do {
    prev = parts.join('');
    if (parts.length > 1 && VERSION_TOKENS.test(parts[parts.length - 1])) {
      parts = parts.slice(0, -1);
    }
  } while (parts.join('') !== prev);
  const peeled = parts.join('');
  // Also peel a trailing numeric/copy suffix fused without a separator
  // (userService2 → userservice).
  stem = stem.replace(/(copy|clone|backup|bak|final|draft|tmp|temp|v\d+|\d+)$/i, '') || stem;
  return peeled.length >= stem.length ? stem : (peeled || stem);
}

/** Token set for Jaccard: identifier-ish words, lowercased, deduped. */
function tokenize(content) {
  const set = new Set();
  const re = /[A-Za-z_$][\w$]{2,}/g;
  let m;
  while ((m = re.exec(String(content || ''))) !== null) set.add(m[0].toLowerCase());
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Find whether `{ path, content }` duplicates one of `siblings`.
 *
 * @param {object} opts
 * @param {string} opts.path     the NEW file's path
 * @param {string} opts.content  the NEW file's content
 * @param {Array<{path:string, content:string}>} opts.siblings existing files to compare against
 * @returns {{ duplicate: boolean, existingPath: string|null, similarity: number, reason: string|null, signals: object }}
 */
function findDuplicateModule({ path: newPath, content, siblings } = {}) {
  const none = { duplicate: false, existingPath: null, similarity: 0, reason: null, signals: {} };
  if (!newPath || !Array.isArray(siblings) || siblings.length === 0) return none;

  const newAbs = path.resolve(String(newPath));
  const newStem = nameStem(newPath);
  const newSyms = extractSymbols(content, newPath);
  const newTokens = tokenize(content);
  const symOverlapTh = dupSymbolOverlap();
  const contentTh = dupContentJaccard();
  const minSyms = dupMinSymbols();

  let best = null; // { existingPath, similarity, reason }

  for (const sib of siblings) {
    if (!sib || !sib.path) continue;
    // Never compare a file with itself (path may differ by normalization).
    if (path.resolve(String(sib.path)) === newAbs) continue;
    const sibContent = typeof sib.content === 'string' ? sib.content : '';

    // ── Signal 1: name collision after version/copy peeling ──
    // Only meaningful when both look like the same KIND of file (same ext).
    if (newStem && newStem.length >= 3 && extOf(sib.path) === extOf(newPath)) {
      if (nameStem(sib.path) === newStem && path.basename(sib.path) !== path.basename(newPath)) {
        const cand = { existingPath: sib.path, similarity: 1, reason: 'name', signals: { nameStem: newStem } };
        // Name collision is decisive — return immediately.
        return { duplicate: true, ...cand };
      }
    }

    // ── Signal 2: exported-symbol overlap ──
    if (newSyms.size >= minSyms) {
      const sibSyms = extractSymbols(sibContent, sib.path);
      if (sibSyms.size > 0) {
        const { ratio, shared } = symbolOverlap(newSyms, sibSyms);
        if (ratio >= symOverlapTh && (!best || ratio > best.similarity)) {
          best = { existingPath: sib.path, similarity: ratio, reason: 'symbols', signals: { shared: shared.slice(0, 8), ratio } };
        }
      }
    }

    // ── Signal 3: content near-clone (token Jaccard) ──
    if (newTokens.size >= 8 && sibContent) {
      const j = jaccard(newTokens, tokenize(sibContent));
      if (j >= contentTh && (!best || j > best.similarity)) {
        best = { existingPath: sib.path, similarity: j, reason: 'content', signals: { jaccard: j } };
      }
    }
  }

  if (best) return { duplicate: true, ...best };
  return none;
}

module.exports = { findDuplicateModule, nameStem, tokenize, jaccard };
