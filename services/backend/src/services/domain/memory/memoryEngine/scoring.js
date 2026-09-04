/**
 * memoryEngine/scoring.js — relevance ranking for proactive memory recall.
 *
 * Extends the memdir keyword-overlap baseline with three signals the bare
 * selector lacks:
 *   1. time-decay — recently-modified memories rank higher (exponential decay,
 *      half-life scoped by retention tier), so fresh context surfaces first.
 *   2. type-filter — restrict/boost by memory type (user|feedback|project|reference).
 *   3. semantic recall — embedding cosine similarity contributes a *recall*
 *      pool of its own (see rankMemories), so a paraphrased query can surface a
 *      memory that shares no tokens with it.
 *
 * Signals 1–2 are pure. Signal 3 delegates every side effect to
 * ./vectorRecall (which in turn delegates all network IO to
 * services/embeddingClient), and is fully fail-soft: if embeddings are
 * unavailable the ranking degrades to the exact pre-existing keyword formula.
 */
'use strict';

const memdir = require('../../../../memdir/memdir');
const staleness = require('../../../memoryStaleness');
const memoryTier = require('../../../memoryTier');

const recallTokens = require('./memoryRecallTokens');
const vectorRecall = require('./vectorRecall');

const VALID_TYPES = ['user', 'feedback', 'project', 'reference'];

// ── Priming (query-independent) ranking constants ───────────────────────────
// Session-start / topic-switch priming surfaces durable memories WITHOUT any
// query overlap — the gap rankMemories cannot fill (it returns [] on empty
// query). Rank = tier-priority × recency × type-preference, stale entries
// excluded. Reuses the same recency SSOT as rankMemories.
const TIER_RANK = Object.freeze({ permanent: 3, cross_session: 2, short_term: 1 });
const PRIMING_TYPE_BONUS = Object.freeze({
  user: 1.3,
  feedback: 1.2,
  project: 1.1,
  reference: 0.9,
});

// Field weights for keyword overlap (mirror selectRelevantMemories).
const WEIGHT_NAME = 3;
const WEIGHT_DESC = 2;
const WEIGHT_TYPE = 1;
const WEIGHT_BODY = 1;

// ── Hybrid (lexical ∪ semantic) recall constants ────────────────────────────
// Legislated defaults; every one is env-overridable (zero-hardcoding rule).
//
// SEM_FLOOR is the load-bearing one. Cosine similarity between two arbitrary
// short texts under a general-purpose embedding model is rarely near zero — a
// floor is what separates "semantically related" from "both are prose". Below
// the floor a purely-semantic candidate scores exactly 0 and is dropped, which
// is also what keeps the existing contract test `无查询重叠 → null`
// (tests/services/memoryEngine/recallUnified.test.js) green.
const SEM_FLOOR_DEFAULT = 0.35;
const SEM_WEIGHT_DEFAULT = 0.5;
const VEC_POOL_FACTOR_DEFAULT = 4;
// Additive smoothing for the lexical normalizer. See _lexNorm — without it, a
// pool whose best keyword overlap is trivial still normalizes that best entry to
// a full 1.0, which is what let three shared high-frequency characters outrank a
// perfect semantic match.
const LEX_SOFT_DEFAULT = 6;
const SHORT_TERM_HALFLIFE_DAYS_DEFAULT = 1;
const BASE_HALFLIFE_DAYS_DEFAULT = 30;

const OFF = /^(0|false|no|off)$/i;

function _envNum(name, def, min, max) {
  const v = parseFloat(process.env[name]);
  if (!Number.isFinite(v)) {
    return def;
  }
  let r = v;
  if (typeof min === 'number') {
    r = Math.max(min, r);
  }
  if (typeof max === 'number') {
    r = Math.min(max, r);
  }
  return r;
}

function _envOn(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') {
    return true;
  }
  return !OFF.test(String(v).trim());
}

/** Semantic similarity floor: below this, the semantic contribution is 0. */
function semFloor() {
  return _envNum('KHY_MEMORY_VECTOR_FLOOR', SEM_FLOOR_DEFAULT, 0, 0.99);
}

/** Weight of the semantic signal in the blend; lexical gets `1 - this`. */
function semWeight() {
  return _envNum('KHY_MEMORY_VECTOR_WEIGHT', SEM_WEIGHT_DEFAULT, 0, 1);
}

/** Semantic candidate pool size = limit × this. */
function _vecPoolFactor() {
  return _envNum('KHY_MEMORY_VECTOR_POOL_FACTOR', VEC_POOL_FACTOR_DEFAULT, 1, 50);
}

/**
 * Additive smoothing constant for the lexical normalizer.
 * `0` reverts to plain pool-max normalization.
 */
function lexSoft() {
  return _envNum('KHY_MEMORY_LEX_SOFT', LEX_SOFT_DEFAULT, 0, 1000);
}

/**
 * Normalize a keyword-overlap score into [0, 1) for blending with the semantic
 * signal: `kw / (maxKw + LEX_SOFT)`.
 *
 * Plain pool-max normalization (`kw / maxKw`) is scale-invariant, which is why it
 * was chosen — `keywordScore` grows with query length, so no fixed reference
 * scale works. But it also throws away the *absolute* strength of the lexical
 * signal: whatever happens to be the best match in the pool gets a full 1.0, even
 * when "best" means three shared high-frequency characters. Measured on the
 * fixed 20-memory / 5-query case (tests/services/memoryEngine/
 * vectorRecallQuality.test.js), that promoted pure noise (`keywordScore = 3`,
 * cosine 0) to the same 0.5 as a *perfect* semantic match (`keywordScore = 0`,
 * cosine 1.0) — after which the deterministic tiebreak (recency, then filename)
 * decided the ranking, and the semantic hit fell out of Top-3. A paraphrased
 * query losing to arbitrary function-word overlap is precisely the failure this
 * whole layer exists to prevent.
 *
 * Additive smoothing fixes that without giving up scale-invariance, because it
 * self-adjusts: when the pool's lexical evidence is strong (`maxKw >> LEX_SOFT`)
 * the term is negligible and behavior is unchanged; when it is weak the term
 * damps the whole pool toward 0, which is the honest reading of "nothing here
 * really matched the words". Crucially, ordering *within* the lexical pool is
 * untouched — the map is monotone in `kw` either way — so this only moves the
 * lexical/semantic balance, never the lexical-only result order.
 *
 * @param {number} kw
 * @param {number} maxKw
 * @returns {number}
 */
function _lexNorm(kw, maxKw) {
  const denom = maxKw + lexSoft();
  return denom > 0 ? kw / denom : 0;
}

/**
 * Whether the recency half-life is tier-scoped. Default on;
 * `KHY_MEMORY_TIER_HALFLIFE ∈ {0,false,no,off}` reverts to one global half-life
 * (byte-identical to the pre-change behavior).
 */
function tierHalfLifeEnabled() {
  return _envOn('KHY_MEMORY_TIER_HALFLIFE');
}

/**
 * Half-life (in days) for the recency multiplier, scoped by retention tier.
 *
 * Before this was a single global value, which contradicted the tier model:
 * `memoryTier.forgetPolicy('permanent')` states "永久层:永不自动遗忘", yet a
 * permanent memory's score still halved every 30 days. Tier-scoped half-lives
 * make the ranking agree with the retention semantics:
 *
 *   permanent     → Infinity (recency ≡ 1 — never decays by age)
 *   cross_session → KHY_MEMORY_HALFLIFE_DAYS (default 30)
 *   short_term    → KHY_MEMORY_HALFLIFE_SHORT_DAYS (default 1)
 *
 * @param {string} [tier] - one of memoryTier.TIERS; omitted ⇒ base half-life
 * @returns {number} days, possibly Infinity
 */
function _halfLifeDays(tier) {
  const base = _envNum('KHY_MEMORY_HALFLIFE_DAYS', BASE_HALFLIFE_DAYS_DEFAULT, 0.001);
  if (!tier || !tierHalfLifeEnabled()) {
    return base;
  }
  if (tier === memoryTier.TIERS.PERMANENT) {
    return Infinity;
  }
  if (tier === memoryTier.TIERS.SHORT_TERM) {
    return _envNum('KHY_MEMORY_HALFLIFE_SHORT_DAYS', SHORT_TERM_HALFLIFE_DAYS_DEFAULT, 0.001);
  }
  return base;
}

/**
 * Recency multiplier in (0, 1]: 1.0 for a just-touched memory, 0.5 at one
 * half-life old, asymptotically approaching 0. `nowMs` is injectable for
 * deterministic tests.
 *
 * @param {number} modifiedAtMs
 * @param {number} nowMs
 * @param {string} [tier] - retention tier; scopes the half-life (see _halfLifeDays)
 * @returns {number}
 */
function recencyMultiplier(modifiedAtMs, nowMs, tier) {
  const halfLife = _halfLifeDays(tier);
  if (!Number.isFinite(halfLife)) {
    return 1; // permanent: age never discounts the score
  }
  const ageMs = Math.max(0, nowMs - modifiedAtMs);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
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
    overlap(queryTokens, ef(fm.name)) * WEIGHT_NAME +
    overlap(queryTokens, ef(fm.description)) * WEIGHT_DESC +
    overlap(queryTokens, ef(fm.type)) * WEIGHT_TYPE +
    overlap(queryTokens, ef(body)) * WEIGHT_BODY
  );
}

/**
 * Normalize a type-filter option into a Set of allowed types, or null for "all".
 *
 * @param {string|string[]|null} types
 * @returns {Set<string>|null}
 */
function normalizeTypeFilter(types) {
  if (!types) {
    return null;
  }
  const list = Array.isArray(types) ? types : String(types).split(/[,\s]+/);
  const valid = list
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => VALID_TYPES.includes(t));
  return valid.length ? new Set(valid) : null;
}

/**
 * Shared ordering: score desc, then recency (newest first), then filename —
 * fully deterministic so identical inputs always yield identical output.
 *
 * @param {Array<object>} entries
 * @param {number} limit
 * @returns {Array<object>}
 */
function _sortAndCap(entries, limit) {
  entries.sort(
    (a, b) =>
      b.score - a.score || b.modifiedAt - a.modifiedAt || a.filename.localeCompare(b.filename)
  );
  return entries.slice(0, limit);
}

/**
 * Rank memories by combined relevance, over the **union** of two recall pools:
 *
 *   - lexical pool  — keyword overlap ≥ `minScore` (unchanged from before)
 *   - semantic pool — top-K by embedding cosine similarity over ALL memories
 *
 * Why the union matters: before this change the vector step ran *after* the
 * `minScore` filter and *after* `slice(0, limit)`, so cosine similarity could
 * only reshuffle memories that had already matched lexically. A memory that was
 * semantically on-point but shared no tokens with a paraphrased query could
 * never be recalled — which is the one thing vector retrieval exists to fix.
 * Truncation now happens after the union, not before it.
 *
 * Blended score for a pooled memory:
 *
 *   lexNorm = keywordScore / (maxKeywordScoreInPool + LEX_SOFT)   ∈ [0,1)
 *   semNorm = max(0, (cos - FLOOR) / (1 - FLOOR))                 ∈ [0,1]
 *   score   = (W_LEX·lexNorm + W_SEM·semNorm) × recency
 *
 * (See _lexNorm for why the lexical term is smoothed rather than normalized by
 * the pool maximum alone.)
 *
 * Entries scoring exactly 0 are dropped, so a memory that is neither a lexical
 * match nor above the semantic floor is never returned (preserving the
 * zero-overlap ⇒ no-recall contract).
 *
 * **Degrade (F4)**: when vector recall is off or the embedding backend is
 * unreachable, this falls through to the original `score = keywordScore ×
 * recency` on the lexical pool — the *same expression*, not a normalized
 * approximation of it, so absolute scores and `minScore` boundaries are
 * byte-identical to the pre-change behavior.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=5]
 * @param {number} [opts.minScore=1]     - minimum *keyword* overlap for the lexical pool
 * @param {string|string[]} [opts.types] - restrict to these memory types
 * @param {number} [opts.nowMs]          - injectable clock for tests
 * @param {boolean} [opts.enableVector]  - force semantic recall on/off
 * @returns {Promise<Array<{filename,frontmatter,body,score,keywordScore,recency,modifiedAt,tier,vectorScore?}>>}
 */
async function rankMemories(query, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 5;
  const minScore = Number.isFinite(opts.minScore) ? opts.minScore : 1;
  const typeFilter = normalizeTypeFilter(opts.types);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  const queryTokens = recallTokens.enrichTokens(memdir._tokenizeForRecall(query), query);
  if (queryTokens.size === 0) {
    return [];
  }

  let list;
  try {
    list = memdir.listMemories();
  } catch {
    list = [];
  }

  // ── Pass 1: read every candidate ONCE, score lexically. ───────────────────
  // No extra IO versus before: readMemory was already called for every entry
  // ahead of the minScore gate. The difference is that non-matching entries are
  // now kept around as semantic candidates instead of being discarded here.
  const all = [];
  for (const entry of list) {
    const fm = entry.frontmatter || {};
    if (typeFilter && !typeFilter.has(String(fm.type || '').toLowerCase())) {
      continue;
    }

    const parsed = memdir.readMemory(entry.filename);
    if (!parsed.exists) {
      continue;
    }

    const modifiedAtMs =
      entry.modifiedAt instanceof Date
        ? entry.modifiedAt.getTime()
        : Number(entry.modifiedAt) || nowMs;
    const tier = memoryTier.classifyTier(fm);

    all.push({
      filename: entry.filename,
      frontmatter: fm,
      body: parsed.body,
      keywordScore: keywordScore(queryTokens, fm, parsed.body),
      recency: recencyMultiplier(modifiedAtMs, nowMs, tier),
      modifiedAt: modifiedAtMs,
      tier,
    });
  }

  const lexPool = all.filter((m) => m.keywordScore >= minScore);

  // ── Semantic recall over the FULL candidate list (not the lexical subset). ─
  const enableVector = opts.enableVector ?? vectorRecall.isEnabled();
  let sims = null;
  if (enableVector && all.length > 0) {
    try {
      sims = await vectorRecall.recall(query, all, { nowMs });
    } catch {
      sims = null; // fail-soft → degrade path below
    }
  }

  if (!sims) {
    // ── Degrade: the original expression, verbatim (F4). ───────────────────
    for (const m of lexPool) {
      m.score = m.keywordScore * m.recency;
    }
    return _sortAndCap(lexPool, limit);
  }

  // ── Hybrid: union of the lexical pool and the semantic top-K. ────────────
  const floor = semFloor();
  const wSem = semWeight();
  const wLex = 1 - wSem;

  const semTopK = [...sims.entries()]
    .filter(([, cos]) => cos > floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(limit, Math.floor(limit * _vecPoolFactor())))
    .map(([filename]) => filename);

  const pooled = new Map();
  for (const m of lexPool) {
    pooled.set(m.filename, m);
  }
  const byName = new Map(all.map((m) => [m.filename, m]));
  for (const filename of semTopK) {
    const m = byName.get(filename);
    if (m) {
      pooled.set(filename, m);
    }
  }

  const pool = [...pooled.values()];
  let maxKw = 0;
  for (const m of pool) {
    if (m.keywordScore > maxKw) {
      maxKw = m.keywordScore;
    }
  }

  for (const m of pool) {
    const lexNorm = _lexNorm(m.keywordScore, maxKw);
    const cos = Math.min(1, Math.max(0, sims.get(m.filename) ?? 0));
    const semNorm = floor >= 1 ? 0 : Math.max(0, (cos - floor) / (1 - floor));
    m.vectorScore = cos;
    m.score = (wLex * lexNorm + wSem * semNorm) * m.recency;
  }

  const survivors = pool.filter((m) => m.score > 0);
  const result = _sortAndCap(survivors, limit);

  // Hit accounting for the (not-yet-implemented) cold-memory decay tier.
  // Default off — see vectorRecall.hitsEnabled.
  try {
    vectorRecall.noteHits(
      result.map((m) => m.filename),
      nowMs
    );
  } catch {
    /* stats must never affect retrieval */
  }
  return result;
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
 * @param {boolean} [opts.bodies=true]    - read each survivor's body; pass false
 *                                          when only the ranking is needed (the
 *                                          project-memory packer ranks a whole
 *                                          index and would otherwise read every
 *                                          memory file for nothing)
 * @returns {Array<{filename,frontmatter,body,score,recency,tierRank,tier,modifiedAt}>}
 */
function rankForPriming(opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 3;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const env = opts.env || process.env;
  const typeFilter = normalizeTypeFilter(opts.types);

  let list;
  try {
    list = memdir.listMemories();
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || list.length === 0) {
    return [];
  }

  const scored = [];
  for (const entry of list) {
    if (!entry || !entry.filename) {
      continue;
    }
    const fm = entry.frontmatter || {};
    const type = String(fm.type || '').toLowerCase();
    if (typeFilter && !typeFilter.has(type)) {
      continue;
    }

    const modifiedAtMs =
      entry.modifiedAt instanceof Date
        ? entry.modifiedAt.getTime()
        : Number(entry.modifiedAt) || nowMs;

    // Exclude stale memories (respects KHY_MEMORY_STALENESS via the SSOT; when
    // that gate is off, assessStaleness never reports stale → nothing dropped).
    const updatedMs = staleness.parseUpdatedMs(fm.updated);
    const effUpdatedMs = updatedMs == null ? modifiedAtMs : updatedMs;
    try {
      if (staleness.assessStaleness({ type, updatedMs: effUpdatedMs, nowMs }, env).stale) {
        continue;
      }
    } catch {
      /* fail-soft: never drop a memory on assessment error */
    }

    const tier = memoryTier.classifyTier(fm);
    const tierRank = TIER_RANK[tier] || TIER_RANK.cross_session;
    const recency = recencyMultiplier(modifiedAtMs, nowMs, tier);
    const typeBonus = PRIMING_TYPE_BONUS[type] || 1.0;

    scored.push({
      filename: entry.filename,
      frontmatter: fm,
      tierRank,
      recency,
      score: tierRank * recency * typeBonus,
      modifiedAt: modifiedAtMs,
      tier,
      body: '', // filled lazily below for the top-N survivors only
    });
  }

  const top = _sortAndCap(scored, limit);

  // Read bodies only for the survivors (bounded IO), and only if asked.
  if (opts.bodies === false) {
    return top;
  }
  for (const m of top) {
    try {
      const parsed = memdir.readMemory(m.filename);
      m.body = parsed && parsed.exists ? parsed.body : '';
    } catch {
      m.body = '';
    }
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
  // Hybrid-recall knobs, exported so tests and diagnostics read the same values
  // the ranker uses instead of re-deriving them from env.
  semFloor,
  semWeight,
  lexSoft,
  tierHalfLifeEnabled,
  _internals: { _halfLifeDays, _vecPoolFactor, _lexNorm, _sortAndCap },
};
