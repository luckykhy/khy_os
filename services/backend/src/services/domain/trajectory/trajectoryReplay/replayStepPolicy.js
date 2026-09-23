'use strict';

/**
 * replayStepPolicy.js — per-step replay POLICY helpers, extracted behavior-neutral
 * from replayEngine.js so that host stays ≤ the 400-line managed ceiling. Pure leaf:
 * reads only opts + process.env + its own DEFAULT_STEP_TIMEOUT_MS const, and lazily
 * requires the (legacy) execApproval symbol/pattern helpers — zero references back to
 * replayEngine (no cycle). replayEngine re-requires and re-binds these names so its
 * public surface stays byte-identical.
 */

const DEFAULT_STEP_TIMEOUT_MS = 120000;

function _stepTimeoutMs(opts) {
  if (opts && Number.isFinite(opts.activityTimeoutMs) && opts.activityTimeoutMs > 0) {
    return opts.activityTimeoutMs;
  }
  const n = parseInt(process.env.KHY_REPLAY_STEP_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STEP_TIMEOUT_MS;
}

/** Parse the env-configured pre-approved SHELL command patterns. */
function _shellAllowList(opts) {
  const fromOpts = Array.isArray(opts && opts.preApprovedShell) ? opts.preApprovedShell : [];
  const raw = process.env.KHY_REPLAY_SHELL_ALLOW;
  const fromEnv = (raw == null || raw === '' ? '' : raw)
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...fromOpts, ...fromEnv];
}

/** Decide whether a SHELL step is pre-approved by a command pattern. */
function _shellPreApproved(step, allowList) {
  if (!allowList.length) {
    return false;
  }
  const command =
    step && step.params && typeof step.params.command === 'string' ? step.params.command : '';
  if (!command) {
    return false;
  }
  try {
    const { matchCommandPattern } = require('../../../execApproval');
    return allowList.some((p) => matchCommandPattern(command, p));
  } catch {
    return false;
  }
}

/** Stamp the unforgeable EXEC_APPROVED symbol onto a params clone. */
function _approveParams(params) {
  const clone = params && typeof params === 'object' ? { ...params } : {};
  try {
    const { EXEC_APPROVED } = require('../../../execApproval');
    if (EXEC_APPROVED) {
      clone[EXEC_APPROVED] = true;
    }
  } catch {
    /* without the symbol the funnel may prompt; replay opts handle that */
  }
  return clone;
}

/**
 * Build the control responder the engine hands to executeTool for a step the
 * tier gate has ALREADY approved for replay (防呆④). The syscall gateway runs
 * before requestPermission and evaluates independently of EXEC_APPROVED, so the
 * engine answers its control channel as a non-interactive but policy-driven host:
 * approve and supply the L2 typed-confirmation word. This fires only for steps
 * the engine decided to replay (FILE always; SHELL only when pre-approved/
 * confirmed) — NETWORK_AI is skipped before ever reaching the funnel — so it is
 * bounded to the user's locked replay policy and never a global loosening.
 */
function _replayControlResponder() {
  const L2_WORD = process.env.KHY_REPLAY_L2_CONFIRM || 'YES';
  return async () => ({ behavior: 'allow', typed: L2_WORD });
}

module.exports = {
  DEFAULT_STEP_TIMEOUT_MS,
  _stepTimeoutMs,
  _shellAllowList,
  _shellPreApproved,
  _approveParams,
  _replayControlResponder,
};
