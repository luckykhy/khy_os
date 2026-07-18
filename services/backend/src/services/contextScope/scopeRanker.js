'use strict';

/**
 * scopeRanker.js — score candidate files against task signals.
 *
 * Pure scoring. Given the signals from taskSignalExtractor and the `.ai/`
 * index from aiMapIndex, produce a ranked candidate list, each with the
 * concrete reasons it scored — so the read plan is explainable, not a black box.
 *
 * Scoring weights (additive; higher = more clearly relevant):
 *   - exact `.ai` symbol match for an identifier ...... 10
 *   - `.ai` basename/keyword match ..................... 5
 *   - identifier appears in the filename .............. 6
 *   - file/path hint literally names the file ......... 9
 *   - directory-hint match in the path ............... 3
 *   - extension-hint match ............................ 2
 *   - keyword match in `.ai` index .................... 3
 *   - recentFiles boost (already in working set) ...... 2
 *   - multi-signal bonus (>=2 distinct signal kinds) .. 2
 *
 * No I/O, no model. Returns candidates sorted by score desc, ties broken by
 * shorter path (more specific) then lexicographic for stability.
 */

const WEIGHTS = Object.freeze({
  aiSymbol: 10,
  fileHintExact: 9,
  partialSymbol: 7, // identifier is a substring of an indexed symbol (e.g. syscall_dispatch ⊂ syscall_dispatch_frame)
  filenameId: 6,
  aiKeyword: 5,
  dirHint: 3,
  aiKeywordWord: 3,
  extHint: 2,
  recentFile: 2,
  multiSignal: 2,
});

const PARTIAL_MIN_LEN = 5; // only treat reasonably specific identifiers as substrings

function _basename(p) { return String(p).split('/').pop() || String(p); }
function _normalise(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }

/**
 * @param {object} signals  output of taskSignalExtractor.extractSignals
 * @param {object} index    output of aiMapIndex.buildIndex
 * @param {object} [opts]    { recentFiles?: string[] }
 * @returns {Array<{path:string, score:number, reasons:string[], signalKinds:number}>}
 */
function rankCandidates(signals, index, opts = {}) {
  const sig = signals || {};
  const recentFiles = new Set((opts.recentFiles || []).map(_normalise));
  const scores = new Map(); // path -> { score, reasons:Set, kinds:Set }

  const bump = (file, amount, reason, kind) => {
    const p = _normalise(file);
    if (!p) return;
    let e = scores.get(p);
    if (!e) { e = { score: 0, reasons: new Set(), kinds: new Set() }; scores.set(p, e); }
    e.score += amount;
    e.reasons.add(reason);
    if (kind) e.kinds.add(kind);
  };

  const idxOk = index && index.ok;
  const lookup = (tok) => (idxOk ? (index.byKeyword.get(String(tok).toLowerCase()) || null) : null);

  // 1) identifiers — strongest task signal. Exact `.ai` symbol > filename match.
  for (const id of sig.identifiers || []) {
    const hits = lookup(id);
    if (hits) {
      for (const f of hits) {
        const entry = idxOk ? index.files.get(f) : null;
        const isSymbol = entry && entry.symbols.has(id);
        bump(f, isSymbol ? WEIGHTS.aiSymbol : WEIGHTS.aiKeyword,
          isSymbol ? `symbol "${id}" in .ai` : `"${id}" mapped via .ai`, 'identifier');
      }
    }
    // Filename containing the identifier (covers files absent from `.ai`).
    if (idxOk) {
      const idLow = id.toLowerCase();
      for (const f of index.files.keys()) {
        if (_basename(f).toLowerCase().includes(idLow)) {
          bump(f, WEIGHTS.filenameId, `filename matches "${id}"`, 'identifier');
        }
      }
      // Partial symbol match: the task names a base symbol whose `.ai` entry is
      // a longer variant (syscall_dispatch → syscall_dispatch_frame/_raw). Only
      // for specific-enough identifiers, and never when an exact hit existed.
      if (!hits && idLow.length >= PARTIAL_MIN_LEN) {
        for (const [kw, fileSet] of index.byKeyword) {
          if (kw.length > idLow.length && kw.includes(idLow)) {
            for (const f of fileSet) bump(f, WEIGHTS.partialSymbol, `"${id}" ⊂ symbol "${kw}"`, 'identifier');
          }
        }
      }
    }
  }

  // 2) explicit file hints — the task literally named a file.
  for (const fh of sig.fileHints || []) {
    const fhn = _normalise(fh);
    const base = _basename(fhn).toLowerCase();
    if (idxOk) {
      for (const f of index.files.keys()) {
        const fl = f.toLowerCase();
        if (fl === fhn.toLowerCase() || fl.endsWith(`/${base}`) || _basename(f).toLowerCase() === base) {
          bump(f, WEIGHTS.fileHintExact, `file hint "${fh}"`, 'fileHint');
        }
      }
    }
    // Even without an index, surface the named path itself as a candidate.
    bump(fhn, WEIGHTS.fileHintExact, `named file "${fh}"`, 'fileHint');
  }

  // 3) keywords (incl. CJK) — softer, only via `.ai` index.
  for (const kw of sig.keywords || []) {
    const hits = lookup(kw);
    if (hits) for (const f of hits) bump(f, WEIGHTS.aiKeywordWord, `keyword "${kw}"`, 'keyword');
  }

  // 4) quoted strings often name a function/file precisely.
  for (const q of sig.quoted || []) {
    const hits = lookup(q);
    if (hits) for (const f of hits) bump(f, WEIGHTS.aiKeyword, `quoted "${q}"`, 'quoted');
  }

  // 5) directory + extension hints refine, never originate, a candidate.
  for (const [p, e] of scores) {
    const pl = p.toLowerCase();
    for (const d of sig.dirHints || []) {
      if (new RegExp(`(^|/)${d.toLowerCase()}(/|$)`).test(pl)) { e.score += WEIGHTS.dirHint; e.reasons.add(`dir "${d}"`); }
    }
    for (const ext of sig.extHints || []) {
      if (pl.endsWith(ext.toLowerCase())) { e.score += WEIGHTS.extHint; e.reasons.add(`ext "${ext}"`); }
    }
    if (recentFiles.has(p)) { e.score += WEIGHTS.recentFile; e.reasons.add('recently touched'); }
    if (e.kinds.size >= 2) { e.score += WEIGHTS.multiSignal; e.reasons.add('multiple signals'); }
  }

  const out = Array.from(scores.entries()).map(([p, e]) => ({
    path: p,
    score: e.score,
    reasons: Array.from(e.reasons),
    signalKinds: e.kinds.size,
  }));

  out.sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length) || a.path.localeCompare(b.path));
  return out;
}

module.exports = { rankCandidates, WEIGHTS };
