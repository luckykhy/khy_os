'use strict';

/**
 * triggerGate.js — pure decision for the completion-time audit→fix loop.
 *
 * Per product directive ("阶段性任务或大任务完成时调用"), the audit→fix cycle is
 * NOT run on every turn — only when the turn looks like a real engineering task
 * completing. The user picked the trigger scope: modified files OR an execution
 * plan OR Goal mode. Trivial chat (no edits, no plan, not Goal mode) is left
 * alone so a "讲个笑话" turn never pays the cost of spawning audit + fix agents.
 *
 * It also must never fire inside a sub-agent: the audit and fix agents are
 * themselves sub-agents, and re-triggering the loop inside them would recurse.
 * The main loop guards this with !_isSubagent and passes it through here too.
 *
 * No I/O, no deps — pure function of its inputs + env. Fail-safe by omission:
 * unknown env values fall back to the documented defaults.
 */

/** Default minimum modified-file count that counts as "改了文件". */
const DEFAULT_MIN_FILES = 1;
/** Default bound on automatic audit→fix→re-audit rounds. */
const DEFAULT_MAX_ROUNDS = 2;

function _envFlagEnabled(raw, dflt) {
  if (raw == null || raw === '') return dflt;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function _envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Whether the audit→fix loop is enabled (default on; KHY_AUDIT_FIX_LOOP=0 disables). */
function isEnabled() {
  return _envFlagEnabled(process.env.KHY_AUDIT_FIX_LOOP, true);
}

/** Bound on automatic rounds (audit → fix → re-audit). KHY_AUDIT_FIX_MAX_ROUNDS, default 2. */
function maxRounds() {
  return _envInt('KHY_AUDIT_FIX_MAX_ROUNDS', DEFAULT_MAX_ROUNDS, 1, 5);
}

/** Per-dispatch timeout (seconds) for each spawned audit/fix sub-agent. */
function dispatchTimeoutSeconds() {
  return _envInt('KHY_AUDIT_FIX_TIMEOUT_S', 180, 30, 1200);
}

/**
 * Decide whether the completion-time audit→fix loop should run for this turn.
 *
 * @param {object} sig
 * @param {number}  [sig.modifiedFileCount=0] - files successfully modified this turn
 * @param {boolean} [sig.hasExecutionPlan=false] - the loop parsed a multi-step plan
 * @param {boolean} [sig.goalModeActive=false] - autonomous Goal mode is active
 * @param {boolean} [sig.isSubagent=false] - this loop IS a spawned sub-agent
 * @returns {{ audit: boolean, reason: string, triggers?: object }}
 */
function shouldAudit(sig = {}) {
  const {
    modifiedFileCount = 0,
    hasExecutionPlan = false,
    goalModeActive = false,
    isSubagent = false,
  } = sig;

  // Never recurse: audit/fix agents are themselves sub-agents.
  if (isSubagent) return { audit: false, reason: 'subagent' };
  if (!isEnabled()) return { audit: false, reason: 'disabled' };

  const minFiles = _envInt('KHY_AUDIT_FIX_MIN_FILES', DEFAULT_MIN_FILES, 1, 1000);
  const fileTrigger = Number(modifiedFileCount) >= minFiles;
  const planTrigger = !!hasExecutionPlan;
  const goalTrigger = !!goalModeActive;

  if (fileTrigger || planTrigger || goalTrigger) {
    return {
      audit: true,
      reason: fileTrigger ? 'modified-files' : (planTrigger ? 'execution-plan' : 'goal-mode'),
      triggers: { file: fileTrigger, plan: planTrigger, goal: goalTrigger },
    };
  }
  // Trivial chat: no edits, no plan, not Goal mode.
  return { audit: false, reason: 'trivial' };
}

module.exports = {
  shouldAudit,
  isEnabled,
  maxRounds,
  dispatchTimeoutSeconds,
  DEFAULT_MIN_FILES,
  DEFAULT_MAX_ROUNDS,
};
