'use strict';

/**
 * budgetController.js — the "accurate, not omniscient" core.
 *
 * Given a ranked candidate list (scopeRanker output), decide how much to
 * actually read. Reading everything is the failure mode this module exists to
 * prevent. Selection stops at the FIRST of:
 *   1. budget_full          — hit the hard maxFiles (or maxBytes) ceiling
 *   2. diminishing_returns  — next candidate's score is a small fraction of the
 *                             top score; more reading buys little
 *   3. confidence_satisfied — accumulated signal is already enough to act on
 *   4. exhausted            — ran out of candidates
 *   5. no_candidates        — nothing relevant found
 *
 * A stopReason is ALWAYS returned. The function never selects "all files".
 *
 * Confidence model: a saturating function of the summed scores of selected
 * candidates — strong, specific hits saturate fast; weak scattered hits don't.
 */

const DEFAULTS = Object.freeze({
  maxFiles: 8,           // hard ceiling on files to read
  minFiles: 1,           // always try to select at least this many when available
  maxBytes: 256 * 1024,  // optional ceiling when candidate.size is known
  marginalFloorRatio: 0.18, // stop once score < ratio * topScore (after minFiles)
  satisfiedConfidence: 0.85, // stop once confidence crosses this (after minFiles)
  confidenceScale: 18,   // larger = needs more accumulated score to feel confident
});

function _clampPositive(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function _confidence(sumScore, scale) {
  // 1 - e^(-sum/scale): 0 at sum=0, saturates toward 1.
  if (sumScore <= 0) return 0;
  return Number((1 - Math.exp(-sumScore / scale)).toFixed(4));
}

/**
 * @param {Array<{path:string, score:number, reasons?:string[], size?:number}>} ranked
 * @param {object} [budget]
 * @returns {{selected:Array, deferred:Array, stopReason:string, confidence:number, budget:object}}
 */
function applyBudget(ranked, budget = {}) {
  const cfg = {
    maxFiles: Math.floor(_clampPositive(budget.maxFiles, DEFAULTS.maxFiles)),
    minFiles: Math.floor(_clampPositive(budget.minFiles, DEFAULTS.minFiles)),
    maxBytes: Math.floor(_clampPositive(budget.maxBytes, DEFAULTS.maxBytes)),
    marginalFloorRatio: _clampPositive(budget.marginalFloorRatio, DEFAULTS.marginalFloorRatio),
    satisfiedConfidence: _clampPositive(budget.satisfiedConfidence, DEFAULTS.satisfiedConfidence),
    confidenceScale: _clampPositive(budget.confidenceScale, DEFAULTS.confidenceScale),
  };
  if (cfg.minFiles > cfg.maxFiles) cfg.minFiles = cfg.maxFiles;

  const list = Array.isArray(ranked) ? ranked.filter((c) => c && c.path) : [];
  if (list.length === 0) {
    return { selected: [], deferred: [], stopReason: 'no_candidates', confidence: 0, budget: cfg };
  }

  const topScore = Math.max(0, Number(list[0].score) || 0);
  const marginalFloor = topScore * cfg.marginalFloorRatio;

  const selected = [];
  let sumScore = 0;
  let usedBytes = 0;
  let stopReason = 'exhausted';

  for (let i = 0; i < list.length; i += 1) {
    const cand = list[i];
    const haveMin = selected.length >= cfg.minFiles;

    // (1) hard ceiling — files
    if (selected.length >= cfg.maxFiles) { stopReason = 'budget_full'; break; }

    // (1b) hard ceiling — bytes (only enforced once minimum met and size known)
    const size = Number(cand.size) || 0;
    if (haveMin && size > 0 && usedBytes + size > cfg.maxBytes) { stopReason = 'budget_full'; break; }

    // (2) diminishing returns — only after the floor of minFiles is met
    const score = Number(cand.score) || 0;
    if (haveMin && score < marginalFloor) { stopReason = 'diminishing_returns'; break; }

    // accept
    selected.push(cand);
    sumScore += score;
    usedBytes += size;

    // (3) confidence satisfied — only after minFiles
    if (selected.length >= cfg.minFiles && _confidence(sumScore, cfg.confidenceScale) >= cfg.satisfiedConfidence) {
      stopReason = 'confidence_satisfied';
      break;
    }
  }

  const deferred = list.slice(selected.length);
  return {
    selected,
    deferred,
    stopReason,
    confidence: _confidence(sumScore, cfg.confidenceScale),
    budget: cfg,
  };
}

/**
 * Defense: clamp an externally-produced selection (e.g. from a model refinement
 * pass) back inside the hard ceiling. The model may reorder/prune candidates,
 * but it can NEVER expand reading beyond maxFiles or beyond the candidate set.
 * @param {Array} candidates  the allowed universe (selected ∪ deferred)
 * @param {string[]} chosenPaths  paths the refiner wants to read
 * @param {object} budget
 * @returns {Array} clamped candidate objects, capped at maxFiles, order preserved
 */
function enforceBudget(candidates, chosenPaths, budget = {}) {
  const maxFiles = Math.floor(_clampPositive(budget.maxFiles, DEFAULTS.maxFiles));
  const byPath = new Map((candidates || []).filter((c) => c && c.path).map((c) => [c.path, c]));
  const out = [];
  const seen = new Set();
  for (const p of chosenPaths || []) {
    const cand = byPath.get(p);
    if (cand && !seen.has(p)) { out.push(cand); seen.add(p); }
    if (out.length >= maxFiles) break;
  }
  return out;
}

module.exports = { applyBudget, enforceBudget, DEFAULTS };
