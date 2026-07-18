'use strict';

/**
 * lrtaBackfill.js — Phase A of the CB-SSP redesign (design doc §4.A).
 *
 * Turns the Ralph / delivery-remediation loop from a blind fixed-count restart
 * into a convergent learning restart (LRTA-star value backfill).
 *
 * Backfill rule (design doc §4.A): h(s) <- min_a [ g(s,a) + h(T(s,a)) ].
 * The trial loop revisits the FIXED initial task state s on every round; trial
 * k spends cost g_k and lands in a state whose admissible remaining estimate is
 * h_k (the Phase B heuristic, heuristic.js). The learned cost-to-goal estimate
 * for s is the running minimum over trials:
 *
 *     H_k = min(H_{k-1},  g_k + h_k),     H_{-1} = +Infinity
 *
 * This is monotone NON-INCREASING by construction (it is a running min), which
 * is exactly the property the design doc names ("跨 trial 价值回填使 h 单调不增,
 * 同实例第 k+1 轮 <= 第 k 轮"). Every round therefore yields an estimate no worse
 * than the previous round — the "finite-budget monotone improvement" of §7,
 * versus the current "no-monotonicity blind restart".
 *
 * Phase B already guarantees each h_k is admissible (an under-estimate); this
 * module only learns across trials and never weakens that guarantee.
 *
 * Persistence is isolated from the boulder checkpoint record: a small sidecar
 * JSON under the same boulder data dir, keyed by the same cwd hash convention
 * (reusing dataHome + boulderState._cwdHash). It therefore cannot corrupt the
 * resume checkpoint schema, yet a later trial / session starts warm.
 *
 * Pure math functions + best-effort persistence. All knobs are env-tunable with
 * safe defaults (zero-hardcoding rule). This module changes no control flow on
 * its own; agenticHarnessService consumes it inside the existing trial loop.
 */

const fs = require('fs');
const path = require('path');

function _envNum(envName, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[envName];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Weight lambda applied to the per-round resource cost g_k. The cost itself is
// a non-negative resource delta (iterations spent this round), so any weight
// >= 0 keeps g_k >= 0 and preserves the running-min monotonicity. Default 1.
function stepCostWeight() {
  return _envNum('KHY_LRTA_STEP_COST_WEIGHT', 1, { min: 0 });
}

/**
 * roundCost(round) -> number >= 0
 *
 * The per-trial step cost g_k. Derived from the resources the round actually
 * spent (iterations), scaled by the env weight. Non-negative by construction so
 * the backfill stays monotone non-increasing.
 *
 * @param {{ iterations?: number }} round
 */
function roundCost(round = {}) {
  const iters = Number(round.iterations);
  const safe = Number.isFinite(iters) && iters > 0 ? iters : 0;
  return stepCostWeight() * safe;
}

/**
 * backfill(prevStoredH, stepCost, hNext) -> number
 *
 * One application of the LRTA-star backfill rule for the fixed start state:
 *     H <- min(prevStoredH, stepCost + hNext)
 *
 * - prevStoredH: the learned estimate from earlier trials (+Infinity / null /
 *   undefined on the first trial).
 * - stepCost (g_k): non-negative cost of this trial (see roundCost).
 * - hNext (h_k): admissible remaining estimate at the state this trial reached.
 *
 * Returns a finite number. Because it is a running minimum, repeated calls form
 * a monotone non-increasing sequence regardless of the inputs' order.
 */
function backfill(prevStoredH, stepCost, hNext) {
  const prev = Number.isFinite(prevStoredH) ? prevStoredH : Infinity;
  const g = Number.isFinite(stepCost) && stepCost > 0 ? stepCost : 0;
  const next = Number.isFinite(hNext) && hNext >= 0 ? hNext : 0;
  const candidate = g + next;
  const result = Math.min(prev, candidate);
  return Number.isFinite(result) ? result : candidate;
}

// ── Isolated persistence (sidecar, never touches the checkpoint record) ──

function _lrtaPath(cwd) {
  const { getDataDir } = require('../utils/dataHome');
  const { _cwdHash } = require('./boulderState');
  return path.join(getDataDir('boulder'), 'lrta', `${_cwdHash(cwd)}.json`);
}

/**
 * loadLearnedHeuristic(cwd) -> { h, taskId, updatedAt } | null
 *
 * Returns the learned cost-to-goal estimate persisted by a prior trial/session,
 * or null when none exists. Best-effort: never throws.
 */
function loadLearnedHeuristic(cwd) {
  if (!cwd) return null;
  try {
    const filePath = _lrtaPath(cwd);
    if (!fs.existsSync(filePath)) return null;
    const rec = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!rec || !Number.isFinite(rec.h)) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * saveLearnedHeuristic(cwd, h, meta?) -> void
 *
 * Persists the backfilled estimate for the next trial/session. Best-effort:
 * never throws. Refuses non-finite values so a corrupt read can never poison
 * a future warm start.
 */
function saveLearnedHeuristic(cwd, h, meta = {}) {
  if (!cwd || !Number.isFinite(h)) return;
  try {
    const filePath = _lrtaPath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const rec = {
      h,
      taskId: meta.taskId ? String(meta.taskId).slice(0, 128) : null,
      round: Number.isFinite(meta.round) ? meta.round : null,
      updatedAt: Number.isFinite(meta.now) ? meta.now : null,
    };
    fs.writeFileSync(filePath, JSON.stringify(rec), 'utf-8');
  } catch {
    /* best-effort — learning is an optimization, never a correctness gate */
  }
}

function clearLearnedHeuristic(cwd) {
  if (!cwd) return;
  try {
    const filePath = _lrtaPath(cwd);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

module.exports = {
  backfill,
  roundCost,
  stepCostWeight,
  loadLearnedHeuristic,
  saveLearnedHeuristic,
  clearLearnedHeuristic,
  _lrtaPath,
};
