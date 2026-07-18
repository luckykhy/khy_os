'use strict';

/**
 * reversibility.js — Phase A of the CB-SSP redesign (design doc §1.3 / §4.A).
 *
 * Action reversibility layering:  A(s) = A_safe (.)(.) A_commit.
 *  - A_safe   : read-only / reversible actions. Executing them does NOT change
 *               the world w, only sharpens the belief b. They are therefore safe
 *               to explore / look ahead / try best-of-N speculatively.
 *  - A_commit : irreversible actions (write, rm, kill, network side effects).
 *               The real world has no "undo", so a commit action is NEVER run
 *               speculatively — only as a one-step optimal commitment.
 *
 * This module provides the classifier and the speculation guard. The guard is
 * the structural guarantee behind §4.A's assertion "任何不可逆动作绝不被投机执行":
 * under a speculative (lookahead) context, only A_safe actions may run; any
 * A_commit action is hard-refused before permission/execution, so a lookahead
 * can only ever incur read-only cost — the irreversible-step budget is untouched
 * by exploration (budget conservation).
 *
 * Pure logic + a best-effort registry lookup. Env-tunable width, zero hardcoding.
 */

function _envInt(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Bounded read-only lookahead beam width k. Design doc fixes k <= 3, so this is
// clamped to [0, 3] regardless of the env override.
function lookaheadWidth() {
  return _envInt('KHY_LOOKAHEAD_WIDTH', 3, { min: 0, max: 3 });
}

/**
 * classifyAction(assessment) -> 'safe' | 'commit'
 *
 * `assessment` follows the riskGate / registry shape { isReadOnly?, isDestructive? }.
 * Conservative by design: an action is 'safe' ONLY when it is explicitly
 * read-only AND not destructive. Everything else — including unknown actions —
 * is 'commit'. We never speculate on the unknown.
 */
function classifyAction(assessment = {}) {
  const a = assessment || {};
  const readOnly = a.isReadOnly === true && a.isDestructive !== true;
  return readOnly ? 'safe' : 'commit';
}

function isReversible(assessment) {
  return classifyAction(assessment) === 'safe';
}

/**
 * speculationGuard(assessment, speculative) -> null | { blocked, error }
 *
 * Returns a structured refusal when an irreversible (A_commit) action is
 * attempted under a speculative context; null when the action is allowed to
 * proceed. Pure — no side effects. The normal (non-speculative) commit path is
 * always allowed here (returns null), so default control flow is unaffected.
 */
function speculationGuard(assessment, speculative) {
  if (!speculative) return null;
  if (classifyAction(assessment) === 'safe') return null;
  return {
    blocked: true,
    error:
      'Speculative lookahead may only execute read-only (A_safe) actions; '
      + 'irreversible (A_commit) actions are never executed speculatively (§4.A).',
  };
}

/**
 * resolveReversibility(permissionKey, params, fallback?) -> { isReadOnly, isDestructive }
 *
 * Resolves the authoritative reversibility flags for a tool from the tool
 * registry (the same source the permission path consults), falling back to the
 * supplied riskGate assessment when the registry has no declaration. Best-effort.
 */
function resolveReversibility(permissionKey, params, fallback = {}) {
  let isReadOnly = fallback.isReadOnly === true;
  let isDestructive = fallback.isDestructive === true;
  try {
    const registry = require('../tools');
    const regTool = registry.get(permissionKey);
    if (regTool) {
      if (typeof regTool.isReadOnly === 'function') isReadOnly = regTool.isReadOnly(params) === true;
      if (typeof regTool.isDestructive === 'function') isDestructive = regTool.isDestructive(params) === true;
    }
  } catch {
    /* registry optional — keep the conservative fallback */
  }
  return { isReadOnly, isDestructive };
}

/**
 * boundedReadOnlyLookahead(candidates, opts?) -> candidate[]
 *
 * The only set an exploration step may execute speculatively: keeps just the
 * A_safe candidates and caps the beam at width k (<= 3). Each candidate is
 * either an assessment object or { assessment }.
 */
function boundedReadOnlyLookahead(candidates = [], opts = {}) {
  const width = Number.isFinite(opts.width)
    ? Math.max(0, Math.min(3, opts.width))
    : lookaheadWidth();
  const list = Array.isArray(candidates) ? candidates : [];
  return list
    .filter((c) => isReversible(c && c.assessment ? c.assessment : c))
    .slice(0, width);
}

module.exports = {
  classifyAction,
  isReversible,
  speculationGuard,
  resolveReversibility,
  boundedReadOnlyLookahead,
  lookaheadWidth,
};
