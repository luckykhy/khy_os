'use strict';

/**
 * guideRetriever.js — find a relevant past "map template" for a new task
 * (DESIGN-ARCH-049, capability B: weak models follow the highest-success path).
 *
 * Reuses learningRetrieval.buildContext as the retrieval engine: stored maps are
 * fed in as extra corpus paths (extraPaths), so we inherit the existing hybrid
 * lexical+vector ranking and the RAG_ENABLED gate — no retrieval logic reinvented.
 * The retrieval score is then blended with each map's deterministic qualityScore
 * so a higher-quality trajectory wins ties.
 *
 *   findGuide(query, {allowVector}) → { map, score, retrievalScore } | null
 *
 * Returns null (not an error) when RAG is disabled or nothing relevant is found —
 * guidance is best-effort and must never break the caller. No model here; the
 * optional embedding rerank lives entirely inside learningRetrieval.
 */

const learningRetrieval = require('../learningRetrieval');
const mapStore = require('./mapStore');

/** Recover a map id from a retrieval chunk source like `fetched:<id>.map.json`. */
function _mapIdFromSource(source) {
  if (typeof source !== 'string') return null;
  const base = source.replace(/^fetched:/, '');
  const m = base.match(/^(.*)\.map\.json$/);
  return m ? m[1] : null;
}

/**
 * Find the best-matching stored map for a query.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {boolean} [opts.allowVector=false]  enable the vector rerank stage.
 * @returns {Promise<{map:object, score:number, retrievalScore:number}|null>}
 */
async function findGuide(query, opts = {}) {
  if (!learningRetrieval.RAG_ENABLED) return null;
  const maps = mapStore.listMaps();
  if (!maps.length) return null;

  // Index maps by their sanitized file basename id for O(1) lookback.
  const byId = new Map();
  const extraPaths = [];
  for (const m of maps) {
    if (!m || !m.id) continue;
    byId.set(m.id, m);
    extraPaths.push(mapStore.pathFor(m.id));
  }
  if (!extraPaths.length) return null;

  let ctx;
  try {
    ctx = await learningRetrieval.buildContext(query, { extraPaths, allowVector: !!opts.allowVector });
  } catch {
    return null; // retrieval failure is non-fatal — no guidance this turn
  }
  if (!ctx || !Array.isArray(ctx.chunks) || ctx.chunks.length === 0) return null;

  // Blend retrieval score with the map's stored qualityScore (deterministic):
  // quality acts as a multiplicative prior in [0.5, 1.0] so a strong-quality map
  // is preferred among comparably-relevant candidates, never resurrected from noise.
  let best = null;
  for (const c of ctx.chunks) {
    const id = _mapIdFromSource(c.source);
    if (!id) continue;
    const map = byId.get(id);
    if (!map) continue;
    const quality = typeof map.qualityScore === 'number' ? map.qualityScore : 0;
    const retrievalScore = typeof c.score === 'number' ? c.score : 0;
    const blended = retrievalScore * (0.5 + 0.5 * quality);
    if (!best || blended > best.score) {
      best = { map, score: blended, retrievalScore };
    }
  }

  return best;
}

module.exports = { findGuide, _mapIdFromSource };
