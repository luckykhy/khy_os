'use strict';

/**
 * heuristic.js — Phase B of the CB-SSP redesign (design doc §4.B).
 *
 * Defines the admissible cost-to-goal heuristic h(s) over the acceptance pack.
 * The delivery gate already enumerates the goal predicates {phi_i}
 * (acceptanceCriteria.buildAcceptancePack); h(s) is a conservative
 * (under-estimating) measure of the work remaining to reach a PASS verdict.
 *
 * Why admissibility matters: a heuristic h is *admissible* iff it never
 * over-estimates the true remaining cost. Admissibility is exactly the
 * property that lets the downstream LRTA-star / A-star search introduced in Phase A
 * (§4.A) retain optimality. Each unmet REQUIRED criterion needs at least one
 * action to satisfy, so counting them with a per-criterion unit cost <= 1 is a
 * provable lower bound on the actions needed to flip the gate to PASS.
 *
 * Pure functions, no side effects. All thresholds are env-tunable with safe
 * defaults (zero-hardcoding rule). This module changes no control flow on its
 * own; agenticHarnessService attaches its output to the delivery-gate report
 * as additive telemetry (zero regression), and Phase A consumes it to drive
 * value backfill and belief calibration.
 */

function _envNum(envName, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[envName];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Per-criterion unit cost. Admissibility requires this be <= 1 (each unmet
// criterion needs at least one action), so it is clamped to [0, 1].
function costPerCriterion() {
  return _envNum('KHY_HEURISTIC_COST_PER_CRITERION', 1, { min: 0, max: 1 });
}

// Weight for optional (non-required) criteria. They are not on the critical
// path to a PASS verdict, so they default below 1 and never inflate the
// admissible core. Clamped to [0, 1].
function optionalWeight() {
  return _envNum('KHY_HEURISTIC_OPTIONAL_WEIGHT', 0.25, { min: 0, max: 1 });
}

// Minimum strict decrease in h that counts as real progress between trials.
function progressEpsilon() {
  return _envNum('KHY_HEURISTIC_PROGRESS_EPSILON', 1e-9, { min: 0 });
}

function _clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function _isSatisfied(result) {
  return !!result && result.status === 'pass';
}

/**
 * computeHeuristic(deliveryGateReport, options?) -> {
 *   h, hAdmissible, atGoal,
 *   unsatisfiedRequired, unsatisfiedOptional,
 *   totalRequired, totalOptional,
 *   costPerCriterion, optionalWeight,
 * }
 *
 * hAdmissible = costPerCriterion * (# unsatisfied REQUIRED criteria)
 *   Provable lower bound on the number of actions needed to flip the delivery
 *   gate to PASS (verdict !== 'fail'): each unmet required criterion needs >= 1
 *   action, and costPerCriterion <= 1.
 *
 * h = hAdmissible + costPerCriterion * optionalWeight * (# unsatisfied OPTIONAL)
 *   A richer signal for stagnation detection. The optional term is advisory and
 *   is kept out of hAdmissible so the admissible guarantee is never weakened.
 */
function computeHeuristic(deliveryGateReport, options = {}) {
  const results = Array.isArray(deliveryGateReport && deliveryGateReport.results)
    ? deliveryGateReport.results
    : [];
  const cpc = options.costPerCriterion !== undefined
    ? _clamp01(options.costPerCriterion, costPerCriterion())
    : costPerCriterion();
  const ow = options.optionalWeight !== undefined
    ? _clamp01(options.optionalWeight, optionalWeight())
    : optionalWeight();

  let unsatisfiedRequired = 0;
  let unsatisfiedOptional = 0;
  let totalRequired = 0;
  let totalOptional = 0;

  for (const r of results) {
    if (r && r.required) {
      totalRequired++;
      if (!_isSatisfied(r)) unsatisfiedRequired++;
    } else {
      totalOptional++;
      if (!_isSatisfied(r)) unsatisfiedOptional++;
    }
  }

  const hAdmissible = cpc * unsatisfiedRequired;
  const h = hAdmissible + cpc * ow * unsatisfiedOptional;

  return {
    h,
    hAdmissible,
    atGoal: unsatisfiedRequired === 0,
    unsatisfiedRequired,
    unsatisfiedOptional,
    totalRequired,
    totalOptional,
    costPerCriterion: cpc,
    optionalWeight: ow,
  };
}

/**
 * shouldCalibrate(prevH, currH) -> boolean
 *
 * True when the heuristic has NOT made progress (currH did not strictly
 * decrease below prevH by more than epsilon) while work still remains
 * (currH > 0). Phase A uses this to trigger a cheap read-only belief
 * re-measurement before paying for more irreversible commits — catching a
 * drifting run at the cheapest moment rather than at the terminal gate.
 */
function shouldCalibrate(prevH, currH) {
  if (!Number.isFinite(prevH) || !Number.isFinite(currH)) return false;
  if (currH <= 0) return false; // already at goal — nothing to calibrate
  const eps = progressEpsilon();
  return currH >= prevH - eps;
}

module.exports = {
  computeHeuristic,
  shouldCalibrate,
  costPerCriterion,
  optionalWeight,
  progressEpsilon,
};
