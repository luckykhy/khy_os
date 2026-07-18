'use strict';

/**
 * capabilityVector.js — the capability "向量" a marshal election ranks on.
 *
 * The existing `modelTier` spine classifies a model into a discrete ordinal tier
 * (T0 frontier > T1 strong > T2 default > T3 weak). That ordinal is the right
 * backbone, but the marshal subsystem needs two things the tier alone does not
 * give:
 *   1. a continuous, comparable SCORE so a pool of models can be ranked and the
 *      single best one elected (§2 auto-election: "reasoning 得分最高");
 *   2. a STRENGTH verdict (strong vs weak) that decides which appointment
 *      protocol governs the marshal (§3 weak-master vs §4 strong-master).
 *
 * Both are derived deterministically from the tier — this module adds NO new
 * model knowledge, it only projects the four tiers onto a capability vector whose
 * headline dimension is `reasoning` (the dimension §2 names for election).
 *
 * Pure + side-effect free. Every cutoff is env-overridable with a named default
 * (zero hardcoding, mirroring modelTier's KHY_* convention).
 *
 * Env:
 *   KHY_MARSHAL_STRONG_THRESHOLD   reasoning score at/above which a marshal is
 *                                  "strong" (default 65 → T0/T1 strong, T2/T3 weak)
 */

const { resolveTier, harnessProfile } = require('../modelTier');

// Capability vector per tier. `reasoning` is the election headline; the other
// dimensions feed the aggregate score and document why a tier is (un)fit to plan
// freely. Monotone in the tier order T0 > T1 > T2 > T3 on every dimension.
const TIER_VECTORS = Object.freeze({
  T0: Object.freeze({ reasoning: 100, planning: 95, instruction: 95, jsonStrict: 95 }),
  T1: Object.freeze({ reasoning: 75, planning: 72, instruction: 78, jsonStrict: 80 }),
  T2: Object.freeze({ reasoning: 50, planning: 45, instruction: 55, jsonStrict: 60 }),
  T3: Object.freeze({ reasoning: 20, planning: 15, instruction: 32, jsonStrict: 40 }),
});

// Aggregate-score weights. reasoning dominates (it is what plans well), planning
// next, then instruction-following, then JSON strictness. Sum = 1.0.
const SCORE_WEIGHTS = Object.freeze({
  reasoning: 0.5, planning: 0.25, instruction: 0.15, jsonStrict: 0.1,
});

const DEFAULT_STRONG_THRESHOLD = 65;

function _envNum(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Reasoning cutoff for the strong/weak split (env-overridable). */
function strongThreshold() {
  return _envNum('KHY_MARSHAL_STRONG_THRESHOLD', DEFAULT_STRONG_THRESHOLD, { min: 0, max: 100 });
}

/**
 * The capability vector for a model id, projected from its resolved tier.
 * @param {string} modelId
 * @param {{forceTier?: string}} [opts]
 * @returns {{tier:string, reasoning:number, planning:number, instruction:number, jsonStrict:number}}
 */
function capabilityVector(modelId, opts = {}) {
  const tier = resolveTier(modelId, opts);
  const v = TIER_VECTORS[tier] || TIER_VECTORS.T2;
  return { tier, ...v };
}

/**
 * Aggregate capability score in [0,100] — the value an election maximizes.
 * @param {string} modelId
 * @param {{forceTier?: string}} [opts]
 * @returns {number}
 */
function capabilityScore(modelId, opts = {}) {
  const v = capabilityVector(modelId, opts);
  const raw = v.reasoning * SCORE_WEIGHTS.reasoning
    + v.planning * SCORE_WEIGHTS.planning
    + v.instruction * SCORE_WEIGHTS.instruction
    + v.jsonStrict * SCORE_WEIGHTS.jsonStrict;
  return Math.round(raw * 100) / 100;
}

/**
 * Full assessment of a candidate marshal: tier, vector, aggregate score, and the
 * strength verdict that selects the appointment protocol. A marshal is "strong"
 * iff its reasoning score is at/above the threshold; otherwise "weak" — and a
 * weak marshal is governed by the weak-master adaptation protocol (§3), never
 * left to free-form planning.
 *
 * @param {string} modelId
 * @param {{forceTier?: string}} [opts]
 * @returns {{modelId:string, tier:string, vector:object, score:number,
 *   strength:'strong'|'weak', harness:object}}
 */
function assess(modelId, opts = {}) {
  const vector = capabilityVector(modelId, opts);
  const score = capabilityScore(modelId, opts);
  const strength = vector.reasoning >= strongThreshold() ? 'strong' : 'weak';
  return {
    modelId: String(modelId || ''),
    tier: vector.tier,
    vector,
    score,
    strength,
    harness: harnessProfile(vector.tier),
  };
}

/** True iff the model would be governed by the strong-master protocol. */
function isStrong(modelId, opts = {}) {
  return assess(modelId, opts).strength === 'strong';
}

module.exports = {
  TIER_VECTORS,
  SCORE_WEIGHTS,
  DEFAULT_STRONG_THRESHOLD,
  strongThreshold,
  capabilityVector,
  capabilityScore,
  assess,
  isStrong,
};
