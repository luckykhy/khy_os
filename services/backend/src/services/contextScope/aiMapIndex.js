'use strict';

/**
 * aiMapIndex.js — runtime consumption of the project's `.ai/` seed docs.
 *
 * The repo deterministically generates `.ai/MAP.md` + `.ai/CONTEXT.yaml`
 * (per-file symbols & call-chains) via projectMetadataService, but until now
 * nothing READ them at agent runtime. This module closes that gap: it parses
 * those docs into a lightweight file → {keywords, symbols} index plus an
 * inverted keyword → files map, so a task's signals can be mapped to the exact
 * files the project's own map says are relevant.
 *
 * Design choices:
 *   - No real YAML parser. The `.ai/` format is custom/annotated; we scan lines
 *     for path-like tokens, `@file:line` references, and symbol identifiers,
 *     attributing the surrounding words to each file as keywords. Robust to the
 *     human-authored authoritative variant and the machine SKELETON.auto.md.
 *   - mtime-cached per cwd. Rebuilds only when either source file changes.
 *   - Fail-soft: missing `.ai/`, unreadable files, or parse errors yield an
 *     empty index ({ ok:false }); callers fall back to glob/grep heuristics.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_EXT = /\.(c|h|js|mjs|cjs|ts|tsx|jsx|vue|py|rs|go|java|json|ya?ml|md|sh|asm|mbt)$/i;
// Path-like token: at least one segment + a known source extension.
const RE_PATH = /\b((?:[\w.-]+\/)*[\w.-]+\.(?:c|h|js|mjs|cjs|ts|tsx|jsx|vue|py|rs|go|java|json|ya?ml|md|sh|asm|mbt))\b/gi;
// `@file.ext:1234` or `@file.ext` reference inside signatures.
const RE_AT_REF = /@([\w./-]+\.[A-Za-z]{1,6})(?::\d+)?/g;
// Identifiers worth indexing as symbols.
const RE_SYMBOL = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g;

const _cache = new Map(); // cwd -> { sig, index }

function _statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// 收敛到 utils/readFileSyncSafe 单一真源(逐字节委托,调用点不变)
const _read = require('../../utils/readFileSyncSafe');

function _addKeyword(byKeyword, kw, file) {
  const key = kw.toLowerCase();
  let set = byKeyword.get(key);
  if (!set) { set = new Set(); byKeyword.set(key, set); }
  set.add(file);
}

function _ensureFile(files, file) {
  let entry = files.get(file);
  if (!entry) { entry = { path: file, keywords: new Set(), symbols: new Set() }; files.set(file, entry); }
  return entry;
}

function _normalisePath(raw) {
  let p = String(raw || '').replace(/\\/g, '/').trim();
  p = p.replace(/^\.\//, '');
  return p;
}

/**
 * Parse the combined `.ai/` text into the index structures.
 * @param {string} text
 * @returns {{files: Map, byKeyword: Map}}
 */
function _parse(text) {
  const files = new Map();
  const byKeyword = new Map();

  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;

    // Collect every path-like token + @ref on this line.
    const onLine = new Set();
    let m;
    RE_PATH.lastIndex = 0;
    while ((m = RE_PATH.exec(line)) !== null) {
      if (SOURCE_EXT.test(m[1])) onLine.add(_normalisePath(m[1]));
    }
    RE_AT_REF.lastIndex = 0;
    while ((m = RE_AT_REF.exec(line)) !== null) {
      if (SOURCE_EXT.test(m[1])) onLine.add(_normalisePath(m[1]));
    }
    if (onLine.size === 0) continue;

    // Attribute the line's symbols/words to each file mentioned on it.
    const symbols = [];
    RE_SYMBOL.lastIndex = 0;
    while ((m = RE_SYMBOL.exec(line)) !== null) symbols.push(m[1]);

    for (const file of onLine) {
      const entry = _ensureFile(files, file);
      // The basename of the path itself is a strong keyword.
      const base = file.split('/').pop();
      _addKeyword(byKeyword, base, file);
      const baseNoExt = base.replace(/\.[^.]+$/, '');
      if (baseNoExt && baseNoExt !== base) _addKeyword(byKeyword, baseNoExt, file);

      for (const sym of symbols) {
        // Skip the path fragments themselves and pure extensions.
        if (SOURCE_EXT.test(`.${sym}`)) continue;
        entry.symbols.add(sym);
        _addKeyword(byKeyword, sym, file);
      }
    }
  }

  return { files, byKeyword };
}

/**
 * Build (or return cached) index for a working directory.
 * @param {string} cwd
 * @returns {{ok:boolean, fileCount:number, files:Map, byKeyword:Map, sources:string[]}}
 */
function buildIndex(cwd) {
  const root = cwd || process.cwd();
  const mapPath = path.join(root, '.ai', 'MAP.md');
  const ctxPath = path.join(root, '.ai', 'CONTEXT.yaml');
  const autoPath = path.join(root, '.ai', 'SKELETON.auto.md');

  const sig = [mapPath, ctxPath, autoPath].map(_statMtime).join('|');
  const cached = _cache.get(root);
  if (cached && cached.sig === sig) return cached.index;

  const sources = [];
  let text = '';
  for (const p of [ctxPath, mapPath, autoPath]) {
    if (_statMtime(p) > 0) {
      const body = _read(p);
      if (body) { text += `\n${body}`; sources.push(p); }
    }
  }

  let index;
  if (!text.trim()) {
    index = { ok: false, fileCount: 0, files: new Map(), byKeyword: new Map(), sources: [] };
  } else {
    try {
      const { files, byKeyword } = _parse(text);
      index = { ok: files.size > 0, fileCount: files.size, files, byKeyword, sources };
    } catch {
      index = { ok: false, fileCount: 0, files: new Map(), byKeyword: new Map(), sources };
    }
  }

  _cache.set(root, { sig, index });
  return index;
}

/**
 * Look up candidate files for a single token against the index.
 * Matches basenames and indexed symbols, case-insensitively. Returns file paths.
 * @param {object} index
 * @param {string} token
 * @returns {string[]}
 */
function lookup(index, token) {
  if (!index || !index.ok || !token) return [];
  const set = index.byKeyword.get(String(token).toLowerCase());
  return set ? Array.from(set) : [];
}

function _clearCacheForTest() { _cache.clear(); }

module.exports = { buildIndex, lookup, _clearCacheForTest, _parse };
