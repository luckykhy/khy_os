'use strict';

/**
 * composer.js — the route planner (pure function).
 *
 * Given request signals (intentGate modes), the model's capability vector, a
 * budget, the runtime ctx, the descriptor catalog, and the preset catalog, it
 * selects and ORDERS the applicable capabilities into an inspectable Route.
 *
 * Pure: no I/O, no env reads. The caller resolves env into `flagResolver` (a
 * closure that returns the enabled boolean for a descriptor) so this module
 * stays deterministic and unit-testable. Mirrors the activate()+dedupe idiom of
 * services/acceptanceCriteria.buildAcceptancePack and the ranked-query shape of
 * services/gateway/capabilityRegistry.
 *
 * Cut 1 inertness: when `capabilityVector` is all-max and `budget` is Infinity,
 * steps 4 (capability filter) and 6 (budget knapsack) are no-ops, so the route's
 * `active` set equals exactly today's flag+precondition gating — observability
 * without behavior change.
 */

const { SEAM_ORDER } = require('./seams');

const MAX_DIM = 5;

/**
 * @param {object} args
 * @param {object} args.signals      - { modes: string[] } from intentGate
 * @param {object} [args.capabilityVector] - { dim: 0..5 }; default all-max
 * @param {number} [args.budget]     - cost ceiling; default Infinity
 * @param {object} args.ctx          - runtime ctx for preconditions
 * @param {Array}  args.descriptors  - descriptor catalog
 * @param {object} [args.preset]     - selected preset (or null)
 * @param {function} args.flagResolver - (descriptor) => boolean (enabled)
 * @param {function} [args.requirementsMatcher] - (requires, vector) => boolean
 * @returns {object} Route
 */
function composeRoute(args) {
  const {
    signals = { modes: [] },
    capabilityVector = null,
    budget = Infinity,
    ctx = {},
    descriptors = [],
    preset = null,
    flagResolver,
    requirementsMatcher = defaultRequirementsMatcher,
  } = args || {};

  const vector = capabilityVector || _allMaxVector();
  const presetOrder = preset && Array.isArray(preset.capabilities) ? preset.capabilities : null;
  const presetSet = presetOrder ? new Set(presetOrder) : null;

  const steps = [];
  const gatedOff = [];
  const suppressed = [];

  for (const d of descriptors) {
    // ② flag resolution
    const enabled = !!flagResolver(d);
    // ③ precondition filter
    const preOk = _safePrecondition(d, ctx);
    // ④ model-capability filter (inert in cut 1)
    const capOk = requirementsMatcher(d.requires || {}, vector);

    let reason = null;
    if (!enabled) reason = 'gated-off';
    else if (!preOk) reason = _suppressionReason(d, ctx);
    else if (!capOk) reason = `capability-gap:${_firstGap(d.requires, vector)}`;

    const eligible = enabled && preOk && capOk;

    const step = {
      id: d.id,
      label: d.label,
      seam: d.seam,
      phase: d.phase,
      owner: d.owner,
      wired: !!d.wired,
      enabled,
      eligible,
      reason,
      requires: d.requires || {},
      cost: d.cost || 0,
      isReversible: d.isReversible !== false,
      inPreset: presetSet ? presetSet.has(d.id) : false,
    };
    steps.push(step);

    if (!enabled) gatedOff.push({ id: d.id, reason: 'gated-off' });
    else if (!preOk) suppressed.push({ id: d.id, reason: step.reason });
  }

  // ⑤ preset/signal overlay: if a preset is selected, eligible capabilities not
  //    in the preset are deprioritized (kept eligible in cut 1 — observability
  //    only — but flagged so the route reads as the preset's shape).
  // ⑦ ordering: stable sort by global rank = SEAM_ORDER[seam] + phase, with the
  //    preset order as a fine tiebreak so a preset reads in its declared order.
  const ranked = steps
    .map((s, i) => ({ s, i, rank: _rank(s, presetOrder) }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.s);

  // ⑥ budget knapsack: drop highest-cost reversible eligible steps until the
  //    eligible cost sum is within budget. Never drop irreversible steps.
  //    Inert when budget === Infinity.
  let active = ranked.filter((s) => s.eligible).map((s) => s.id);
  let budgetUsed = ranked.filter((s) => s.eligible).reduce((sum, s) => sum + (s.cost || 0), 0);
  const budgetDropped = [];
  if (Number.isFinite(budget) && budgetUsed > budget) {
    const eligibleSteps = ranked.filter((s) => s.eligible);
    const droppable = eligibleSteps
      .filter((s) => s.isReversible)
      .sort((a, b) => (b.cost || 0) - (a.cost || 0)); // highest cost first
    const dropIds = new Set();
    for (const s of droppable) {
      if (budgetUsed <= budget) break;
      dropIds.add(s.id);
      budgetUsed -= (s.cost || 0);
      budgetDropped.push({ id: s.id, reason: `budget:${s.cost}` });
    }
    active = active.filter((id) => !dropIds.has(id));
    for (const step of ranked) {
      if (dropIds.has(step.id)) { step.eligible = false; step.reason = 'budget'; }
    }
  }

  return {
    steps: ranked,
    active,
    gatedOff,
    suppressed,
    budgetDropped,
    preset: preset ? { id: preset.id, label: preset.label } : null,
    signals: { modes: Array.isArray(signals.modes) ? signals.modes.slice() : [] },
    budgetUsed,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _allMaxVector() {
  // A vector that satisfies every requirement → step ④ inert.
  return new Proxy({}, { get: () => MAX_DIM });
}

function defaultRequirementsMatcher(requires, vector) {
  for (const [dim, min] of Object.entries(requires || {})) {
    if ((vector[dim] || 0) < min) return false;
  }
  return true;
}

function _firstGap(requires, vector) {
  for (const [dim, min] of Object.entries(requires || {})) {
    const have = vector[dim] || 0;
    if (have < min) return `${dim} ${have}/${min}`;
  }
  return 'none';
}

function _safePrecondition(d, ctx) {
  if (typeof d.preconditions !== 'function') return true;
  try { return !!d.preconditions(ctx); } catch { return false; }
}

function _suppressionReason(d, ctx) {
  if (d.subagentSuppressed && ctx.isSubagent) return 'subagent';
  if (ctx.iteration !== undefined && ctx.iteration !== 1) return 'not-iter-1';
  if (ctx.toolCallsLen !== undefined && ctx.toolCallsLen !== 0) return 'has-toolcalls';
  return 'precondition';
}

function _rank(step, presetOrder) {
  const base = (SEAM_ORDER[step.seam] || 0) + (step.phase || 0);
  if (!presetOrder) return base;
  const idx = presetOrder.indexOf(step.id);
  // In-preset steps keep their seam/phase ordering but are nudged ahead of
  // out-of-preset steps within the same seam band (fine tiebreak only).
  return idx === -1 ? base + 0.5 : base;
}

module.exports = { composeRoute, defaultRequirementsMatcher };
