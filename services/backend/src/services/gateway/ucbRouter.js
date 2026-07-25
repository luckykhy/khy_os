'use strict';

/**
 * ucbRouter.js — Phase C-1 of the CB-SSP redesign (design doc §4.C).
 *
 * Replaces the hand-tuned penalty score `score = basePriority×10 + Σpenalty`
 * for default-route adapter selection with a UCB1 multi-armed bandit.
 *
 * Formalization.  Each adapter is an arm a. Pulling a yields a reward
 *
 *     r(a) = success ? speed(latency) : 0           r(a) ∈ [0, 1]
 *
 * i.e. the empirical mean μ̂_a converges to (success rate × mean speed) — the
 * "臂回报=成功率×速度" the design doc asks for. UCB1 then selects
 *
 *     a* = argmax_a [ μ̂_a + c · sqrt( 2 · ln N / n_a )  −  cooldownDamp_a ]
 *                     \____/   \_______________________/   \____________/
 *                    exploit          explore               cooldown折入探索项
 *
 * where N = Σ n_a is the total pull count and n_a the per-arm pull count. An arm
 * never pulled (n_a = 0) has an infinite exploration term → it is tried first
 * (optimism under uncertainty). A cooling adapter has its exploration bonus
 * damped toward 0 in proportion to its remaining cooldown, so we do not waste a
 * "probe" on an arm we already know is resting — the cooldown is folded INTO the
 * exploration term rather than bolted on as a separate penalty.
 *
 * UCB1's regret after T pulls is O(ln T) (Auer/Cesa-Bianchi/Fischer 2002), so
 * cumulative regret grows sublinearly and the long-run pull fraction concentrates
 * on the best arm — this is what `ucbRouter.test.js` asserts statistically.
 *
 * `failoverOrderStore` order (when the user pins one) seeds an optimistic prior:
 * an earlier-listed adapter starts with a higher prior mean and a small pseudo
 * pull-count, so before any traffic the ranking matches the user's order and the
 * bandit only deviates once evidence accumulates.
 *
 * Arm statistics live in-process (the gateway is a singleton); they are bandit
 * state, not durable truth, so a fresh process simply re-learns — no schema, no
 * persistence coupling. Zero hardcoding: every constant is an env override with a
 * default.
 */

function _envNum(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── Tunables (all env, all defaulted) ──────────────────────────────────────
// Exploration constant c. Classic UCB1 fixes c=1 (the √2 lives in the formula);
// >1 explores more, →0 turns greedy. Clamped non-negative.
function explorationConstant() {
  return _envNum('KHY_UCB_EXPLORATION', 1, { min: 0 });
}
// Reference latency: the speed reward is refLatency / max(latency, refLatency),
// so a call at or under the reference earns full speed credit (1.0) and slower
// calls decay toward 0. Defaults to 8s — a generous "fast enough" bar.
function refLatencyMs() {
  return _envNum('KHY_UCB_REF_LATENCY_MS', 8000, { min: 1 });
}
// Neutral speed credit used when a successful outcome reports no latency.
function neutralSpeed() {
  return _envNum('KHY_UCB_NEUTRAL_SPEED', 0.5, { min: 0, max: 1 });
}
// Prior pseudo-count: how much the failover-order prior is "worth" in pulls.
// Larger → the user's pinned order sticks longer before evidence overrides it.
function priorWeight() {
  return _envNum('KHY_UCB_PRIOR_WEIGHT', 1, { min: 0 });
}

/**
 * speedReward(latencyMs) -> [0,1]
 * Monotone non-increasing in latency; 1.0 at/under the reference, →0 as
 * latency→∞. A missing/invalid latency earns the neutral mid credit so a
 * success is never punished for lacking a timing sample.
 */
function speedReward(latencyMs) {
  const ref = refLatencyMs();
  const l = Number(latencyMs);
  if (!Number.isFinite(l) || l <= 0) return neutralSpeed();
  return ref / Math.max(l, ref);
}

/**
 * outcomeReward({ success, latencyMs }) -> [0,1]
 * r = success ? speed(latency) : 0. Encodes "success rate × speed": averaged
 * over pulls, μ̂ = P(success) · E[speed | success].
 */
function outcomeReward(outcome = {}) {
  if (!outcome || outcome.success !== true) return 0;
  return speedReward(outcome.latencyMs);
}

// ── Arm registry ───────────────────────────────────────────────────────────
// Map<armKey, { pulls, rewardSum, lastOutcomeAt }>. pulls/rewardSum may carry a
// fractional prior seed; that is intentional (a Bayesian-style pseudo-count).
const _arms = new Map();

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _armKey = require('../../utils/trimLowerCase');

function _getArm(key) {
  let arm = _arms.get(key);
  if (!arm) {
    arm = { pulls: 0, rewardSum: 0, lastOutcomeAt: 0 };
    _arms.set(key, arm);
  }
  return arm;
}

/**
 * recordOutcome(adapter, { success, latencyMs, at }) -> void
 * Folds one observation into the arm's running mean. Best-effort: a bad key is
 * ignored rather than thrown, so a record call can never break the request path.
 */
function recordOutcome(adapter, outcome = {}) {
  const key = _armKey(adapter);
  if (!key) return;
  const arm = _getArm(key);
  arm.pulls += 1;
  arm.rewardSum += outcomeReward(outcome);
  arm.lastOutcomeAt = Number(outcome.at) || 0;
}

/**
 * seedPrior(orderList) -> void
 * Installs the failover-order prior as optimistic pseudo-counts. Earlier in the
 * list ⇒ higher prior mean (1 at the head, decaying toward 0 at the tail). Only
 * seeds arms with no real observations yet (pulls below the prior weight), so it
 * never overwrites learned evidence. Idempotent for a given order.
 */
function seedPrior(orderList) {
  const order = Array.isArray(orderList) ? orderList.filter(Boolean) : [];
  if (order.length === 0) return;
  const w = priorWeight();
  if (w <= 0) return;
  const n = order.length;
  order.forEach((adapter, index) => {
    const key = _armKey(adapter);
    if (!key) return;
    const arm = _getArm(key);
    if (arm.pulls >= w) return; // already has real evidence — leave it
    const priorMean = n === 1 ? 1 : 1 - index / n; // head=1 … tail→1/n
    arm.pulls = w;
    arm.rewardSum = priorMean * w;
  });
}

/**
 * cooldownDamp(remainingCooldownMs, maxCooldownMs) -> [0,1]
 * Fraction by which to suppress an arm's exploration bonus while it rests:
 * 0 when not cooling, →1 as the remaining cooldown approaches the window max.
 * Folding this into the exploration term means a resting arm is not "explored"
 * just for being under-sampled.
 */
function cooldownDamp(remainingCooldownMs, maxCooldownMs) {
  const rem = Math.max(0, Number(remainingCooldownMs) || 0);
  if (rem <= 0) return 0;
  const max = Math.max(1, Number(maxCooldownMs) || rem);
  return Math.min(1, rem / max);
}

/**
 * ucbValue(arm, totalPulls, { cooldownRemainingMs, cooldownMaxMs }) -> number
 * The UCB1 score for one arm. +Infinity for an unpulled arm (forced first try).
 */
function ucbValue(arm, totalPulls, opts = {}) {
  const pulls = arm && arm.pulls > 0 ? arm.pulls : 0;
  const mean = pulls > 0 ? arm.rewardSum / pulls : 0;
  if (pulls <= 0) return Number.POSITIVE_INFINITY;
  const N = Math.max(1, Number(totalPulls) || 0);
  const explore = explorationConstant() * Math.sqrt((2 * Math.log(N)) / pulls);
  const damp = cooldownDamp(opts.cooldownRemainingMs, opts.cooldownMaxMs);
  return mean + explore * (1 - damp);
}

/**
 * rank(adapterKeys, opts?) -> Array<{ adapter, value, mean, pulls, explore }>
 * Ranks the given adapters by UCB value descending (best arm first). Pure read
 * over current arm state — does not mutate. `opts.cooldownByKey` maps an adapter
 * key to { remainingMs, maxMs } so a cooling adapter is damped; `opts.priorOrder`
 * (defaults to failoverOrderStore) seeds the prior before ranking.
 */
function rank(adapterKeys = [], opts = {}) {
  const keys = (Array.isArray(adapterKeys) ? adapterKeys : []).map(_armKey).filter(Boolean);
  if (keys.length === 0) return [];

  const priorOrder = opts.priorOrder !== undefined ? opts.priorOrder : _loadFailoverOrder();
  if (priorOrder && priorOrder.length) seedPrior(priorOrder);

  const totalPulls = keys.reduce((sum, k) => sum + (_arms.get(k)?.pulls || 0), 0);
  const cooldownByKey = opts.cooldownByKey || {};

  const scored = keys.map((key, index) => {
    const arm = _getArm(key);
    const cd = cooldownByKey[key] || {};
    const value = ucbValue(arm, totalPulls, {
      cooldownRemainingMs: cd.remainingMs,
      cooldownMaxMs: cd.maxMs,
    });
    const pulls = arm.pulls > 0 ? arm.pulls : 0;
    return {
      adapter: key,
      value,
      mean: pulls > 0 ? arm.rewardSum / pulls : 0,
      pulls,
      index, // preserves caller order as the deterministic tie-break
    };
  });

  scored.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value; // higher UCB first
    return a.index - b.index; // stable: keep incoming order on ties
  });
  return scored;
}

/**
 * select(adapterKeys, opts?) -> string | null
 * The single best arm by UCB, or null when there are no candidates.
 */
function select(adapterKeys, opts) {
  const ranked = rank(adapterKeys, opts);
  return ranked.length > 0 ? ranked[0].adapter : null;
}

function _loadFailoverOrder() {
  try {
    const store = require('./failoverOrderStore');
    const { enabled, order } = store.getFailoverOrder();
    if (enabled && Array.isArray(order) && order.length > 0) return order;
  } catch {
    /* store optional */
  }
  return null;
}

// Test/diagnostic helpers — not part of the request path.
function _getArmStats(adapter) {
  const arm = _arms.get(_armKey(adapter));
  return arm ? { ...arm } : { pulls: 0, rewardSum: 0, lastOutcomeAt: 0 };
}
function _reset() {
  _arms.clear();
}

module.exports = {
  recordOutcome,
  seedPrior,
  rank,
  select,
  ucbValue,
  cooldownDamp,
  speedReward,
  outcomeReward,
  explorationConstant,
  refLatencyMs,
  priorWeight,
  _getArmStats,
  _reset,
};
