/**
 * memoryEngine/scoring.js — relevance ranking for proactive memory recall.
 *
 * Extends the memdir keyword-overlap baseline with two signals the bare
 * selector lacks:
 *   1. time-decay — recently-modified memories rank higher (exponential decay
 *      with a configurable half-life), so fresh context surfaces first.
 *   2. type-filter — restrict/boost by memory type (user|feedback|project|reference).
 *
 * Pure and dependency-free apart from memdir's shared tokenizer, which it
 * reuses so scoring stays single-sourced.
 */
'use strict';

const memdir = require('../../memdir');
const memoryTier = require('../memoryTier');
const staleness = require('../memoryStaleness');
const recallTokens = require('./memoryRecallTokens');

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];

// ── Priming (query-independent) ranking constants ───────────────────────────
// Session-start / topic-switch priming surfaces durable memories WITHOUT any
// query overlap — the gap rankMemories cannot fill (it returns [] on empty
// query). Rank = tier-priority × recency × type-preference, stale entries
// excluded. Reuses the same recency SSOT as rankMemories.
const TIER_RANK = Object.freeze({ permanent: 3, cross_session: 2, short_term: 1 });
const PRIMING_TYPE_BONUS = Object.freeze({ user: 1.3, feedback: 1.2, project: 1.1, reference: 0.9 });

// Field weights for keyword overlap (mirror selectRelevantMemories).
const WEIGHT_NAME = 3;
const WEIGHT_DESC = 2;
const WEIGHT_TYPE = 1;
const WEIGHT_BODY = 1;

/** Half-life (in days) for the recency multiplier. Env-tunable. */
function _halfLifeDays() {
  const v = parseFloat(process.env.KHY_MEMORY_HALFLIFE_DAYS || '');
  return Number.isFinite(v) && v > 0 ? v : 30;
}

/**
 * Recency multiplier in (0, 1]: 1.0 for a just-touched memory, 0.5 at one
 * half-life old, asymptotically approaching 0. `nowMs` is injectable for
 * deterministic tests.
 *
 * @param {number} modifiedAtMs
 * @param {number} nowMs
 * @returns {number}
 */
function recencyMultiplier(modifiedAtMs, nowMs) {
  const ageMs = Math.max(0, nowMs - modifiedAtMs);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const halfLife = _halfLifeDays();
  return Math.pow(0.5, ageDays / halfLife);
}

/**
 * Keyword-overlap score for a memory against query tokens, using memdir's
 * weighted-field math.
 *
 * @param {Set<string>} queryTokens
 * @param {object} frontmatter
 * @param {string} body
 * @returns {number}
 */
function keywordScore(queryTokens, frontmatter, body) {
  const fm = frontmatter || {};
  const tok = memdir._tokenizeForRecall;
  const overlap = memdir._overlapCount;
  // Enrich each field symmetrically with the SAME transform applied to the query
  // (CJK bigrams + canonical alias sentinels), so cross-language / term matches
  // surface. Gate off ⇒ enrichTokens returns a copy of the base set ⇒ scores are
  // byte-identical to the prior keyword-overlap behavior.
  const ef = (t) => recallTokens.enrichTokens(tok(t), t);
  return (
    overlap(queryTokens, ef(fm.name)) * WEIGHT_NAME
    + overlap(queryTokens, ef(fm.description)) * WEIGHT_DESC
    + overlap(queryTokens, ef(fm.type)) * WEIGHT_TYPE
    + overlap(queryTokens, ef(body)) * WEIGHT_BODY
  );
}

/**
 * Normalize a type-filter option into a Set of allowed types, or null for "all".
 *
 * @param {string|string[]|null} types
 * @returns {Set<string>|null}
 */
function normalizeTypeFilter(types) {
  if (!types) return null;
  const list = Array.isArray(types) ? types : String(types).split(/[,\s]+/);
  const valid = list.map((t) => String(t).trim().toLowerCase()).filter((t) => VALID_TYPES.includes(t));
  return valid.length ? new Set(valid) : null;
}

/**
 * Rank all memories by combined relevance = keywordScore × recencyMultiplier,
 * after applying an optional type filter. Returns entries above `minScore`
 * sorted by combined score, capped at `limit`.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=5]
 * @param {number} [opts.minScore=1]    - minimum *keyword* overlap to qualify
 * @param {string|string[]} [opts.types] - restrict to these memory types
 * @param {number} [opts.nowMs]          - injectable clock for tests
 * @returns {Array<{filename,frontmatter,body,score,keywordScore,recency,modifiedAt}>}
 */
function rankMemories(query, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1;
  const typeFilter = normalizeTypeFilter(opts.types);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  const queryTokens = recallTokens.enrichTokens(memdir._tokenizeForRecall(query), query);
  if (queryTokens.size === 0) return [];

  const scored = [];
  let list;
  try { list = memdir.listMemories(); } catch { list = []; }

  for (const entry of list) {
    const fm = entry.frontmatter || {};
    if (typeFilter && !typeFilter.has(String(fm.type || '').toLowerCase())) continue;

    const parsed = memdir.readMemory(entry.filename);
    if (!parsed.exists) continue;

    const kw = keywordScore(queryTokens, fm, parsed.body);
    if (kw < minScore) continue;

    const modifiedAtMs = entry.modifiedAt instanceof Date
      ? entry.modifiedAt.getTime()
      : Number(entry.modifiedAt) || nowMs;
    const recency = recencyMultiplier(modifiedAtMs, nowMs);

    scored.push({
      filename: entry.filename,
      frontmatter: fm,
      body: parsed.body,
      keywordScore: kw,
      recency,
      score: kw * recency,
      modifiedAt: modifiedAtMs,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt || a.filename.localeCompare(b.filename));
  return scored.slice(0, limit);
}

/**
 * Query-INDEPENDENT ranking for session-start / topic-switch priming.
 * Ranks ALL non-stale memories by tier-priority × recency × type-preference,
 * with no dependence on query token overlap (this is exactly the gap that
 * rankMemories — which returns [] on an empty/zero-overlap query — cannot fill).
 *
 * Reuses the shared recency SSOT (recencyMultiplier), the tier SSOT
 * (memoryTier.classifyTier) and the staleness SSOT (memoryStaleness) so the
 * priming layer never diverges from the rest of the memory system.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=3]         - max memories to return
 * @param {number} [opts.nowMs]           - injectable clock for tests
 * @param {string|string[]} [opts.types]  - restrict to these memory types
 * @param {object} [opts.env]             - injectable env (staleness gating)
 * @returns {Array<{filename,frontmatter,body,score,recency,tierRank,modifiedAt}>}
 */
function rankForPriming(opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 3;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const env = opts.env || process.env;
  const typeFilter = normalizeTypeFilter(opts.types);

  let list;
  try { list = memdir.listMemories(); } catch { list = []; }
  if (!Array.isArray(list) || list.length === 0) return [];

  const scored = [];
  for (const entry of list) {
    if (!entry || !entry.filename) continue;
    const fm = entry.frontmatter || {};
    const type = String(fm.type || '').toLowerCase();
    if (typeFilter && !typeFilter.has(type)) continue;

    const modifiedAtMs = entry.modifiedAt instanceof Date
      ? entry.modifiedAt.getTime()
      : Number(entry.modifiedAt) || nowMs;

    // Exclude stale memories (respects KHY_MEMORY_STALENESS via the SSOT; when
    // that gate is off, assessStaleness never reports stale → nothing dropped).
    const updatedMs = staleness.parseUpdatedMs(fm.updated);
    const effUpdatedMs = updatedMs == null ? modifiedAtMs : updatedMs;
    try {
      if (staleness.assessStaleness({ type, updatedMs: effUpdatedMs, nowMs }, env).stale) continue;
    } catch { /* fail-soft: never drop a memory on assessment error */ }

    const tier = memoryTier.classifyTier(fm);
    const tierRank = TIER_RANK[tier] || TIER_RANK.cross_session;
    const recency = recencyMultiplier(modifiedAtMs, nowMs);
    const typeBonus = PRIMING_TYPE_BONUS[type] || 1.0;

    scored.push({
      filename: entry.filename,
      frontmatter: fm,
      tierRank,
      recency,
      score: tierRank * recency * typeBonus,
      modifiedAt: modifiedAtMs,
      body: '', // filled lazily below for the top-N survivors only
    });
  }

  scored.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt || a.filename.localeCompare(b.filename));
  const top = scored.slice(0, limit);

  // Read bodies only for the survivors (bounded IO).
  for (const m of top) {
    try {
      const parsed = memdir.readMemory(m.filename);
      m.body = (parsed && parsed.exists) ? parsed.body : '';
    } catch { m.body = ''; }
  }
  return top;
}

module.exports = {
  VALID_TYPES,
  TIER_RANK,
  PRIMING_TYPE_BONUS,
  recencyMultiplier,
  keywordScore,
  normalizeTypeFilter,
  rankMemories,
  rankForPriming,
};
