'use strict';

/**
 * crossSourceMerge.js — cross-source search result merge + dedup (pure leaf).
 *
 * Khy can search several worlds at once: the local project (file content via
 * grep), local session history (FTS5), and the live web. Those three return
 * structurally DIFFERENT result objects, and the existing web-only dedup
 * (digestResults / _dedupKey) keys on canonical URL — so a local hit, which has
 * no URL, would be silently dropped by it. This module is the single source of
 * truth for merging the three into ONE deduped, provenance-carrying list.
 *
 * Two dedup tiers:
 *   1. Within-source EXACT dedup — by a source-specific key (URL for web, path:line
 *      for local files, sessionId:uuid for history).
 *   2. Cross-source NEAR dedup — by content fingerprint (token-set Jaccard). When a
 *      web result substantially repeats a local hit, the LOCAL copy wins (the
 *      user's own project is authoritative/fresh) and the web duplicate is dropped,
 *      but the surviving local item is annotated (`alsoFoundIn` + `corroboratingUrls`)
 *      so the corroboration stays visible.
 *
 * Design discipline: pure, no I/O, no module state, never throws (inputs coerced).
 * Kept a true leaf — it requires only the tokenizer; it does NOT pull in the heavy
 * webSearchService. The URL canonicalizer below is inlined and deliberately mirrors
 * webSearchService._dedupKey's semantics (lowercase host, strip leading www. and
 * trailing slash, keep query, drop fragment).
 */

const { tokenizeForSearch } = require('../searchTokenizer');

const SOURCE_PRIORITY = { 'local-file': 0, 'local-history': 1, 'web': 2 };

function _int(envName, fallback, min, max) {
  const raw = parseInt(String(process.env[envName] || ''), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function _float(envName, fallback, min, max) {
  const raw = parseFloat(String(process.env[envName] || ''));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function _str(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

/**
 * Canonical URL key — mirrors webSearchService._dedupKey so a page surfaced by
 * both the web pipeline and re-surfaced here collapses identically.
 */
function urlKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    // Drop common tracking params so the same page with/without them collapses.
    const params = new URLSearchParams(u.search);
    for (const k of [...params.keys()]) {
      if (/^(utm_|fbclid$|gclid$|spm$|from$)/i.test(k)) params.delete(k);
    }
    const search = params.toString();
    return `${host}${path}${search ? `?${search}` : ''}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Content fingerprint — a token Set for Jaccard similarity. Reuses the shared
 * CJK/ASCII tokenizer so it matches the rest of the search subsystem's notion
 * of "a term".
 * @returns {Set<string>}
 */
function fingerprint(text) {
  return new Set(tokenizeForSearch(_str(text)));
}

/**
 * Jaccard similarity between two token Sets (|∩| / |∪|). 0 when either is empty.
 */
function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── Normalizers: heterogeneous source shapes → one unified shape ──────────────

/**
 * Web results: { title, url, snippet, domain, type, engines?, engineCount? }.
 * @returns {object[]}
 */
function normalizeWeb(results) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r) continue;
    const title = _str(r.title);
    const url = String(r.url || '').trim();
    if (!title && !url) continue;
    out.push({
      source: 'web',
      title: title || url,
      url,
      path: '',
      line: null,
      snippet: _str(r.snippet || r.description || ''),
      domain: _str(r.domain || ''),
      type: _str(r.type || 'other') || 'other',
      score: Number.isFinite(r.score) ? r.score : (Number.isFinite(r.engineCount) ? r.engineCount : 0),
      engines: Array.isArray(r.engines) ? r.engines : undefined,
      engineCount: Number.isFinite(r.engineCount) ? r.engineCount : undefined,
    });
  }
  return out;
}

/**
 * Local file (grep content-mode) results: { file, line, content }. Accepts either
 * the raw grep tool result ({ matches: [...] }) or a bare array of matches.
 * @returns {object[]}
 */
function normalizeLocalFiles(grepResult, opts = {}) {
  const matches = Array.isArray(grepResult)
    ? grepResult
    : (grepResult && Array.isArray(grepResult.matches) ? grepResult.matches : []);
  const out = [];
  for (const m of matches) {
    if (!m) continue;
    const file = _str(m.file || m.path);
    if (!file) continue;
    const line = Number.isFinite(m.line) ? m.line : null;
    const snippet = _str(m.content || m.snippet || '');
    out.push({
      source: 'local-file',
      title: line != null ? `${file}:${line}` : file,
      url: '',
      path: file,
      line,
      snippet,
      domain: '',
      type: 'local-file',
      score: 0,
    });
  }
  return out;
}

/**
 * Local history (sessionSearchIndex.searchMessages) results:
 * { sessionId, title, role, content, timestamp, uuid, rank }. bm25 `rank` is
 * MORE relevant the more negative it is, so score = -rank.
 * @returns {object[]}
 */
function normalizeHistory(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const content = _str(m.content);
    const sessionId = _str(m.sessionId);
    if (!content && !sessionId) continue;
    out.push({
      source: 'local-history',
      title: _str(m.title) || (sessionId ? `会话 ${sessionId.slice(0, 8)}` : '会话记录'),
      url: '',
      path: sessionId,
      line: null,
      uuid: _str(m.uuid),
      snippet: content,
      domain: '',
      type: 'local-history',
      score: Number.isFinite(m.rank) ? -m.rank : 0,
    });
  }
  return out;
}

// ── Within-source exact key ───────────────────────────────────────────────────

function _exactKey(item) {
  if (item.source === 'web') {
    const k = urlKey(item.url);
    return k ? `web:${k}` : `web:title:${_str(item.title).toLowerCase()}`;
  }
  if (item.source === 'local-file') {
    const p = _str(item.path).toLowerCase().replace(/\\/g, '/');
    return `lf:${p}:${item.line == null ? '' : item.line}`;
  }
  if (item.source === 'local-history') {
    const sid = _str(item.path);
    const u = _str(item.uuid);
    return `lh:${sid}:${u || _str(item.snippet).slice(0, 64).toLowerCase()}`;
  }
  return `${item.source}:${_str(item.title).toLowerCase()}:${_str(item.url).toLowerCase()}`;
}

/**
 * Merge already-normalized unified arrays, dedup within each source (exact key)
 * and across sources (content Jaccard, local-first). Pure.
 *
 * @param {object[][]|object[]} unifiedArrays  one array per source, or a flat array
 * @param {object} [opts]
 * @param {number} [opts.jaccard]   cross-source similarity threshold (default env / 0.82)
 * @param {number} [opts.totalCap]  max items in the merged output (default env / 40)
 * @returns {{ items:object[], total:number, droppedWithinSource:number, droppedCrossSource:number }}
 */
function mergeAndDedupe(unifiedArrays, opts = {}) {
  const threshold = Number.isFinite(opts.jaccard)
    ? opts.jaccard
    : _float('KHY_XSRC_DEDUP_JACCARD', 0.82, 0, 1);
  const totalCap = Number.isFinite(opts.totalCap) && opts.totalCap > 0
    ? opts.totalCap
    : _int('KHY_UNIFIED_TOTAL_CAP', 40, 1, 500);

  // Flatten, tolerating either [[...],[...]] or a single flat array.
  const flat = [];
  const src = Array.isArray(unifiedArrays) ? unifiedArrays : [];
  for (const arr of src) {
    if (Array.isArray(arr)) flat.push(...arr.filter(Boolean));
    else if (arr && typeof arr === 'object') flat.push(arr);
  }

  // Local sources are claimed first so they win any cross-source collision.
  flat.sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9));

  const kept = [];
  const exactSeen = new Set();
  let droppedWithinSource = 0;
  let droppedCrossSource = 0;

  for (const raw of flat) {
    if (!raw || typeof raw !== 'object') continue;
    const item = { ...raw };

    // Tier 1: within-source exact dedup.
    const ek = _exactKey(item);
    if (exactSeen.has(ek)) { droppedWithinSource += 1; continue; }

    // Tier 2: cross-source near dedup. Only a web item can be absorbed by an
    // already-kept LOCAL item (local-first); local items always survive.
    if (item.source === 'web') {
      const fp = fingerprint(`${item.title} ${item.snippet}`);
      let absorbed = false;
      for (const survivor of kept) {
        if (survivor.source === 'web') continue;        // local survivors only
        if (!survivor._fp) survivor._fp = fingerprint(`${survivor.title} ${survivor.snippet}`);
        if (jaccard(fp, survivor._fp) >= threshold) {
          survivor.alsoFoundIn = Array.from(new Set([...(survivor.alsoFoundIn || []), 'web']));
          if (item.url) {
            survivor.corroboratingUrls = Array.from(
              new Set([...(survivor.corroboratingUrls || []), item.url])
            );
          }
          absorbed = true;
          break;
        }
      }
      if (absorbed) { droppedCrossSource += 1; continue; }
      item._fp = fp;
    }

    exactSeen.add(ek);
    kept.push(item);
    if (kept.length >= totalCap) break;
  }

  // Strip the internal fingerprint cache before returning.
  const items = kept.map(({ _fp, ...rest }) => rest);
  return {
    items,
    total: items.length,
    droppedWithinSource,
    droppedCrossSource,
  };
}

module.exports = {
  normalizeWeb,
  normalizeLocalFiles,
  normalizeHistory,
  fingerprint,
  jaccard,
  urlKey,
  mergeAndDedupe,
  SOURCE_PRIORITY,
};
