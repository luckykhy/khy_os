'use strict';

/**
 * projectHygiene/godFile.js — deterministic "god file" assessment for a single
 * write ([DESIGN-ARCH-054], rule 1). A god file is one source file that has
 * grown past the project's size ceiling; the fix is to split it by
 * responsibility, never to keep piling on.
 *
 * Pure: given the resulting file content, decide whether the write would
 * produce a file over the LOC ceiling. The guard layer turns a violation into
 * an approvable block so the user can override deliberately.
 */

const { godFileLoc } = require('./thresholds');
const { extOf } = require('./symbols');

// Extensions worth a LOC ceiling — source code, not data/lockfiles/generated
// blobs (a 10k-line package-lock.json or .csv is not a "god file").
const ASSESSABLE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'cc', 'cpp', 'h', 'hpp',
  'cs', 'swift', 'scala', 'vue', 'svelte',
]);

// Paths that are legitimately long by nature — never flagged as god files.
const EXEMPT_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|.*\.min\.(js|css)|.*\.bundle\.js|.*\.generated\..*|.*\.lock)$/i;

function countLines(content) {
  if (!content) return 0;
  const s = String(content);
  // Count newlines + 1 for a trailing non-empty line; an all-blank file counts
  // its lines honestly (matches archDebtScan's `split('\n').length`).
  return s.split('\n').length;
}

/**
 * @param {object} opts
 * @param {string} opts.path     target file path (for extension gating)
 * @param {string} opts.content  the FULL resulting file content
 * @param {number} [opts.threshold] override LOC ceiling (defaults to env knob)
 * @returns {{ violation: boolean, loc: number, threshold: number, assessable: boolean }}
 */
function assessGodFile({ path: filePath, content, threshold } = {}) {
  const ceiling = Number.isInteger(threshold) && threshold > 0 ? threshold : godFileLoc();
  const ext = extOf(filePath);
  const assessable = ASSESSABLE_EXTS.has(ext) && !EXEMPT_RE.test(String(filePath || ''));
  if (!assessable) {
    return { violation: false, loc: countLines(content), threshold: ceiling, assessable: false };
  }
  const loc = countLines(content);
  return { violation: loc > ceiling, loc, threshold: ceiling, assessable: true };
}

module.exports = { assessGodFile, countLines, ASSESSABLE_EXTS };
