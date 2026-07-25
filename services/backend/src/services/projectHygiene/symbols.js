'use strict';

/**
 * projectHygiene/symbols.js — deterministic, dependency-free extraction of the
 * top-level symbols a source file declares/exports. Used by duplicateModule.js
 * to judge whether a new file re-implements an existing one.
 *
 * Regex-based on purpose (mirrors scripts/archDebtScan.js): an AST parser would
 * choke on the many languages khy can author and on partial/streamed content,
 * whereas a tolerant lexical pass degrades gracefully — a missed symbol only
 * weakens a heuristic, it never crashes the write path.
 *
 * Scope: JS/TS-family today (the bulk of what khy scaffolds). Other languages
 * fall back to an empty set, so the duplicate check leans on name/content
 * signals for them rather than producing wrong symbol matches.
 */

const CODE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
]);

function extOf(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filePath || ''));
  return m ? m[1].toLowerCase() : '';
}

/** Strip line + block comments cheaply (good enough for symbol scanning). */
function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Extract declared/exported top-level symbol names from source text.
 * Captures: function/class declarations, top-level const/let/var bindings,
 * `exports.X = `, and the keys of `module.exports = { X, Y }`.
 *
 * @param {string} content
 * @param {string} [filePath] used only to gate on a code-like extension
 * @returns {Set<string>}
 */
function extractSymbols(content, filePath = '') {
  const out = new Set();
  if (filePath && !CODE_EXTS.has(extOf(filePath))) return out;
  const text = stripComments(content);
  if (!text.trim()) return out;

  const add = (name) => {
    if (name && !/^(if|for|while|switch|return|function|const|let|var|class)$/.test(name)) {
      out.add(name);
    }
  };

  let m;

  // function NAME( ... )  /  async function NAME(
  const fnRe = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnRe.exec(text)) !== null) add(m[1]);

  // class NAME
  const clsRe = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g;
  while ((m = clsRe.exec(text)) !== null) add(m[1]);

  // top-level const/let/var NAME = ...  (indentation <= 2 spaces ≈ module scope)
  const varRe = /(?:^|\n)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = varRe.exec(text)) !== null) add(m[1]);

  // exports.NAME = ...
  const expRe = /(?:^|\n|;)\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = expRe.exec(text)) !== null) add(m[1]);

  // module.exports = { A, B: ..., C }
  const meRe = /module\.exports\s*=\s*\{([^}]*)\}/g;
  while ((m = meRe.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim().replace(/['"]/g, '');
      if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key);
    }
  }

  return out;
}

/**
 * Overlap ratio of a new file's symbols against an existing file's symbols:
 * |new ∩ existing| / |new|. 1.0 means every symbol the new file declares
 * already exists in the other file (a strong duplicate signal).
 *
 * @returns {{ ratio: number, shared: string[] }}
 */
function symbolOverlap(newSymbols, existingSymbols) {
  if (!newSymbols || newSymbols.size === 0) return { ratio: 0, shared: [] };
  const shared = [];
  for (const s of newSymbols) if (existingSymbols.has(s)) shared.push(s);
  return { ratio: shared.length / newSymbols.size, shared };
}

module.exports = { extractSymbols, symbolOverlap, extOf, CODE_EXTS };
