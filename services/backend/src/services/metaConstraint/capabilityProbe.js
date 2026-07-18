'use strict';

/**
 * capabilityProbe.js — 能力向量探测与分级 (目标「元约束架构师」§3.1).
 *
 * The meta-constraint engine allocates locks by the model's *intelligence
 * boundary*, not by a globally hardcoded worst-case. To do that it first needs a
 * graded read of who is executing. This module is that probe.
 *
 * It does NOT introduce any new model knowledge — it projects the EXISTING
 * capability vector (marshal/capabilityVector, itself derived from modelTier)
 * onto a three-band verdict the solver consumes:
 *
 *   guest     宾客原则：高能力 (T0/T1)。释放最大自由度，校验损耗趋零。
 *   standard  标准管控：中等/未知能力 (T2)。常规风险按级加锁。
 *   cage      高压电笼：低能力 (T3)。重点关押，任何写入至少过代码级拦截器。
 *
 * Two 防呆 invariants live here:
 *   ② 自评只能加锁不能减锁 — a model's self-report may only TIGHTEN its band
 *      (declare lower confidence → pulled toward the cage). It can never claim a
 *      higher band than its tier earns. "按最高智商建模" is the optimistic default,
 *      but a model flagging uncertainty is taken at its (more conservative) word.
 *   ① 未知模型 fail-safe — an unresolved/unknown model resolves to T2 (via
 *      modelTier) ⇒ `standard`, never `guest`. Unknown is never trusted as strong.
 *
 * Pure + side-effect free. Every cutoff is env-overridable with a named default
 * (zero hardcoding, mirroring the KHY_* convention used across the codebase).
 *
 * Env:
 *   KHY_METACONSTRAINT_GUEST_REASONING  reasoning score at/above which a model is
 *                                       a "guest" (default 75 → T0/T1)
 *   KHY_METACONSTRAINT_CAGE_REASONING   reasoning score BELOW which a model is
 *                                       "caged" (default 50 → T3; T2 stays standard)
 */

const cap = require('../marshal/capabilityVector');

const BANDS = Object.freeze({
  GUEST: 'guest',
  STANDARD: 'standard',
  CAGE: 'cage',
});

// Strictness rank of a band — higher = more constrained. Used so a self-report
// can only move a model to a stricter (higher-rank) band, never a looser one.
const BAND_RANK = Object.freeze({
  [BANDS.GUEST]: 0,
  [BANDS.STANDARD]: 1,
  [BANDS.CAGE]: 2,
});

const DEFAULT_GUEST_REASONING = 75;
const DEFAULT_CAGE_REASONING = 50;

function _envNum(name, fallback, { min = 0, max = 100 } = {}) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** reasoning cutoff at/above which a model is a guest (env-overridable). */
function guestReasoning() {
  return _envNum('KHY_METACONSTRAINT_GUEST_REASONING', DEFAULT_GUEST_REASONING);
}

/** reasoning cutoff below which a model is caged (env-overridable). */
function cageReasoning() {
  // Clamp so cage < guest always holds (a misconfigured pair must not invert the
  // ladder). If someone sets cage above guest, cage wins only up to guest-ε.
  const guest = guestReasoning();
  const cage = _envNum('KHY_METACONSTRAINT_CAGE_REASONING', DEFAULT_CAGE_REASONING);
  return Math.min(cage, guest);
}

/**
 * Project a reasoning score onto a band. The split is pure thresholds so it is
 * deterministic and explainable.
 * @param {number} reasoning
 * @returns {'guest'|'standard'|'cage'}
 */
function bandForReasoning(reasoning) {
  const r = Number.isFinite(reasoning) ? reasoning : 0;
  if (r < cageReasoning()) return BANDS.CAGE;
  if (r >= guestReasoning()) return BANDS.GUEST;
  return BANDS.STANDARD;
}

/**
 * The stricter (higher-rank) of two bands. Used to apply a self-report monotonically.
 * @returns {string}
 */
function tightenBand(a, b) {
  return rankOfBand(a) >= rankOfBand(b) ? _normBand(a) : _normBand(b);
}

function rankOfBand(b) {
  return Object.prototype.hasOwnProperty.call(BAND_RANK, b) ? BAND_RANK[b] : BAND_RANK[BANDS.CAGE];
}

function _normBand(b) {
  return Object.prototype.hasOwnProperty.call(BAND_RANK, b) ? b : BANDS.CAGE;
}

/**
 * Normalize a self-report into a band the probe may tighten toward. A model may
 * declare its own confidence; we only ever read it as a request to be MORE
 * constrained (防呆②). Accepted forms:
 *   - a band string ('cage'|'standard'|'guest')
 *   - { band }  or  { confidence: 'low'|'medium'|'high' }
 *   - { reasoning } a self-claimed reasoning score (only honored if it LOWERS)
 * Returns null when the report carries no tightening signal.
 *
 * @param {*} selfReport
 * @param {number} baseReasoning the tier-derived reasoning (to clamp self claims)
 * @returns {string|null}
 */
function _selfReportBand(selfReport, baseReasoning) {
  if (selfReport == null) return null;

  if (typeof selfReport === 'string') {
    const s = selfReport.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(BAND_RANK, s) ? s : null;
  }
  if (typeof selfReport !== 'object') return null;

  if (typeof selfReport.band === 'string') {
    const s = selfReport.band.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(BAND_RANK, s)) return s;
  }
  if (typeof selfReport.confidence === 'string') {
    const c = selfReport.confidence.trim().toLowerCase();
    if (c === 'low') return BANDS.CAGE;
    if (c === 'medium') return BANDS.STANDARD;
    // 'high' is NOT a loosening lever — it cannot upgrade past the tier. Ignored.
  }
  if (Number.isFinite(selfReport.reasoning)) {
    // A self-claimed score is honored ONLY when it is lower than the tier's
    // (i.e. the model is admitting weakness). A higher claim is discarded.
    const claimed = Math.min(Number(selfReport.reasoning), baseReasoning);
    return bandForReasoning(claimed);
  }
  return null;
}

/**
 * Probe the capability band for the executing model.
 *
 * @param {string} modelId
 * @param {object} [opts]
 * @param {*}      [opts.selfReport]  model's self-declared confidence/band (may only tighten)
 * @param {string} [opts.forceTier]   test hook forwarded to modelTier
 * @returns {{
 *   modelId:string, tier:string, vector:object, score:number,
 *   band:'guest'|'standard'|'cage',
 *   tierBand:'guest'|'standard'|'cage',
 *   tightenedBySelfReport:boolean,
 *   rationale:string
 * }}
 */
function probe(modelId, opts = {}) {
  const assessment = cap.assess(modelId, { forceTier: opts.forceTier });
  const tierBand = bandForReasoning(assessment.vector.reasoning);

  const reported = _selfReportBand(opts.selfReport, assessment.vector.reasoning);
  const band = reported ? tightenBand(tierBand, reported) : tierBand;
  const tightened = band !== tierBand;

  return {
    modelId: assessment.modelId,
    tier: assessment.tier,
    vector: assessment.vector,
    score: assessment.score,
    band,
    tierBand,
    tightenedBySelfReport: tightened,
    rationale: _rationale(assessment, band, tierBand, tightened),
  };
}

function _rationale(assessment, band, tierBand, tightened) {
  const head = {
    [BANDS.GUEST]: `能力等级 ${assessment.tier}（reasoning=${assessment.vector.reasoning}）≥ 宾客线，按宾客原则释放自由度`,
    [BANDS.STANDARD]: `能力等级 ${assessment.tier}（reasoning=${assessment.vector.reasoning}）属标准区间，常规按级管控`,
    [BANDS.CAGE]: `能力等级 ${assessment.tier}（reasoning=${assessment.vector.reasoning}）< 电笼线，重点关押`,
  }[band] || '未知能力，保守按标准管控';
  if (tightened) {
    return `${head}（注：模型自评置信偏低，已由 ${tierBand} 单调收紧至 ${band}，防呆②）。`;
  }
  return `${head}。`;
}

module.exports = {
  BANDS,
  BAND_RANK,
  DEFAULT_GUEST_REASONING,
  DEFAULT_CAGE_REASONING,
  guestReasoning,
  cageReasoning,
  bandForReasoning,
  tightenBand,
  rankOfBand,
  probe,
};
