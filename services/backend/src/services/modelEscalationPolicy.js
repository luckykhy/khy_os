'use strict';

/**
 * modelEscalationPolicy.js — escalation DECISION policy for the small-model
 * normalization pipeline (stage 4: small→strong model handover, task #6).
 *
 * Answers exactly one question per round: "has this small-model session
 * accumulated enough SEMANTIC failure signals that a stronger model should
 * take over?" — and, if so, which model to hand over to. It never performs
 * the switch itself (that is modelSwitchManager's job) and never touches
 * network/adapter failures (those belong to the aiGateway cascade).
 *
 * Contract — 纯叶子:零 IO、确定性、绝不抛。State lives in a plain object the
 * caller owns (one per loop invocation); this module holds no module-level
 * state. Only relative requires (constants + tier resolver), all lazy and
 * fail-soft. All thresholds come from constants/smallModelDefaults (zero
 * hardcoding); the master gate is flag KHY_AUTO_ESCALATION (default-on).
 *
 * Trigger signals (any one, all wall-clock-free):
 *   1. same tool failing >= thresholds.toolFailureCount CONSECUTIVE times
 *      (a success for that tool resets its counter — "consecutive" semantics)
 *   2. param-correction retry failures (canRetry + _paramCorrection attached
 *      by toolCalling.js) accumulating >= thresholds.paramCorrectionRetries
 *   3. pipeline self-check failures (_pipelineState.selfCheckFailures, i.e.
 *      plan steps marked 'failed') >= thresholds.selfCheckFailures
 *   4. consecutive empty replies >= thresholds.emptyReplyCount
 *
 * Hard constraints:
 *   - escalationsUsed >= getMaxEscalations() → never escalate again
 *   - flag KHY_AUTO_ESCALATION off → never escalate
 *
 * @module services/modelEscalationPolicy
 */

const { getEscalationThresholds, getMaxEscalations } = require('../constants/smallModelDefaults');

// ── Flag gate ────────────────────────────────────────────────────────────────

/**
 * Is auto-escalation enabled? Delegates to flagRegistry (SSOT for
 * KHY_AUTO_ESCALATION, mode default-on); falls back to a raw default-on env
 * parse when the registry is unavailable (e.g. isolated unit tests).
 * @param {object} [env] - Defaults to process.env
 * @returns {boolean}
 */
function isAutoEscalationEnabled(env = process.env) {
  try {
    return require('./flagRegistry').isFlagEnabled('KHY_AUTO_ESCALATION', env);
  } catch {
    const raw = String((env && env.KHY_AUTO_ESCALATION) || '')
      .trim()
      .toLowerCase();
    // default-on: only an explicit off value disables
    return !['0', 'false', 'no', 'off'].includes(raw);
  }
}

// ── Session-scoped escalation state ──────────────────────────────────────────

/**
 * Create a fresh per-session (per-loop) escalation counter state.
 *
 * Fields:
 *   consecutiveToolFailures : Map<toolName, int> — per-tool CONSECUTIVE
 *                             failure streak (success for that tool clears it)
 *   paramCorrectionFailures : int — cumulative failed param-correction ladders
 *   emptyReplies            : int — consecutive empty assistant replies
 *   escalationsUsed         : int — escalations already performed this session
 *   handledSelfCheckFailures: int — selfCheckFailures already consumed by a
 *                             previous escalation (plan-step failures persist
 *                             across rounds, so evaluate() only fires on NEW ones)
 *
 * All updater methods are defensive (never throw on odd input).
 * @returns {object} state
 */
function createEscalationState() {
  const state = {
    consecutiveToolFailures: new Map(),
    paramCorrectionFailures: 0,
    emptyReplies: 0,
    escalationsUsed: 0,
    handledSelfCheckFailures: 0,

    /**
     * Fold one tool result into the counters.
     * - success → that tool's consecutive-failure streak resets to 0
     * - failure → streak +1; if it carries the toolCalling.js correction
     *   signal (canRetry + _paramCorrection) the correction counter also +1
     * - denied / deduped results are neutral (user choice, not model failure)
     * - any tool activity breaks the empty-reply streak (the model produced
     *   tool calls, so the assistant turn was not empty)
     * @param {string} toolName
     * @param {object} result - tool result ({ success, canRetry, _paramCorrection, ... })
     */
    recordToolResult(toolName, result) {
      try {
        // Tool activity of any kind = a non-empty assistant turn.
        state.emptyReplies = 0;
        const name = String(toolName || '')
          .trim()
          .toLowerCase();
        if (!name || !result || typeof result !== 'object') {
          return;
        }
        if (result.denied || result._deduped) {
          return;
        } // neutral outcomes
        if (result.success) {
          // "Consecutive" semantics: one success clears this tool's streak.
          state.consecutiveToolFailures.delete(name);
          return;
        }
        if (result.success === false) {
          state.consecutiveToolFailures.set(
            name,
            (state.consecutiveToolFailures.get(name) || 0) + 1
          );
          // Param-correction ladder exhausted (retryable, audit trail attached).
          if (
            result.canRetry === true &&
            result._paramCorrection &&
            typeof result._paramCorrection === 'object'
          ) {
            state.paramCorrectionFailures += 1;
          }
        }
      } catch {
        /* counters are best-effort — never throw into the loop */
      }
    },

    /** Count one empty assistant reply (consecutive streak). */
    recordEmptyReply() {
      try {
        state.emptyReplies += 1;
      } catch {
        /* never throw */
      }
    },

    /**
     * A substantive (non-empty) assistant turn arrived — break the
     * consecutive empty-reply streak.
     */
    recordAssistantProgress() {
      try {
        state.emptyReplies = 0;
      } catch {
        /* never throw */
      }
    },

    /**
     * An escalation was just performed: consume the triggering counters so
     * the SAME signals cannot immediately re-fire against the new model, and
     * bump the session-wide escalation budget.
     * @param {number} [currentSelfCheckFailures] - _pipelineState.selfCheckFailures
     *        at escalation time (plan-step failures persist, so they are
     *        marked handled rather than reset)
     */
    noteEscalation(currentSelfCheckFailures) {
      try {
        state.escalationsUsed += 1;
        state.consecutiveToolFailures.clear();
        state.paramCorrectionFailures = 0;
        state.emptyReplies = 0;
        const n = Number(currentSelfCheckFailures);
        if (Number.isFinite(n) && n > state.handledSelfCheckFailures) {
          state.handledSelfCheckFailures = n;
        }
      } catch {
        /* never throw */
      }
    },
  };
  return state;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

const _NO_ESCALATION = Object.freeze({ escalate: false, reason: '', targetTier: 'T1' });

/**
 * Evaluate whether the accumulated signals warrant an escalation.
 *
 * Pure decision — no side effects on `state`. Signals are checked in fixed
 * priority order (tool failures → param corrections → self-check → empty
 * replies) so the reason is deterministic when several fire at once.
 *
 * @param {object} state - from createEscalationState()
 * @param {object} pipelineState - loop `_pipelineState` ({ selfCheckFailures, ... });
 *        null/absent tolerated (self-check signal simply cannot fire)
 * @param {object} [opts]
 * @param {object} [opts.env] - Defaults to process.env
 * @returns {{escalate:boolean, reason:string, targetTier:'T1',
 *   signal?:string, counts?:object}}
 *   `signal` ('tool_failure'|'param_correction'|'self_check'|'empty_reply')
 *   and `counts` are machine-readable extras for metrics (task #7).
 */
function evaluate(state, pipelineState, opts = {}) {
  try {
    const env = (opts && opts.env) || process.env;
    if (!state || typeof state !== 'object') {
      return _NO_ESCALATION;
    }
    if (!isAutoEscalationEnabled(env)) {
      return _NO_ESCALATION;
    }
    if (state.escalationsUsed >= getMaxEscalations(env)) {
      return _NO_ESCALATION;
    }

    const th = getEscalationThresholds(env);

    // 1. Same tool failing consecutively.
    if (state.consecutiveToolFailures instanceof Map) {
      for (const [tool, count] of state.consecutiveToolFailures) {
        if (count >= th.toolFailureCount) {
          return {
            escalate: true,
            targetTier: 'T1',
            signal: 'tool_failure',
            counts: { tool, count, threshold: th.toolFailureCount },
            reason: `工具 ${tool} 连续失败 ${count} 次（阈值 ${th.toolFailureCount} 次）`,
          };
        }
      }
    }

    // 2. Param-correction ladder failures (toolCalling.js retry signal).
    if (state.paramCorrectionFailures >= th.paramCorrectionRetries) {
      return {
        escalate: true,
        targetTier: 'T1',
        signal: 'param_correction',
        counts: { count: state.paramCorrectionFailures, threshold: th.paramCorrectionRetries },
        reason: `工具参数纠错失败累计 ${state.paramCorrectionFailures} 次（阈值 ${th.paramCorrectionRetries} 次）`,
      };
    }

    // 3. Pipeline self-check failures (plan steps marked 'failed'). Only NEW
    //    failures since the last escalation count (they persist on the plan).
    const scf = pipelineState && Number(pipelineState.selfCheckFailures);
    if (Number.isFinite(scf)) {
      const fresh = scf - (state.handledSelfCheckFailures || 0);
      if (fresh >= th.selfCheckFailures && th.selfCheckFailures > 0) {
        return {
          escalate: true,
          targetTier: 'T1',
          signal: 'self_check',
          counts: { count: fresh, threshold: th.selfCheckFailures },
          reason: `执行计划自检发现 ${fresh} 个步骤失败（阈值 ${th.selfCheckFailures} 个）`,
        };
      }
    }

    // 4. Consecutive empty replies.
    if (state.emptyReplies >= th.emptyReplyCount) {
      return {
        escalate: true,
        targetTier: 'T1',
        signal: 'empty_reply',
        counts: { count: state.emptyReplies, threshold: th.emptyReplyCount },
        reason: `连续 ${state.emptyReplies} 次空回复（阈值 ${th.emptyReplyCount} 次）`,
      };
    }

    return _NO_ESCALATION;
  } catch {
    return _NO_ESCALATION; // never throw into the loop
  }
}

// ── Target model selection ────────────────────────────────────────────────────

/**
 * Pick the escalation target model.
 *
 * Priority:
 *   1. env KHY_ESCALATION_TARGET_MODEL — explicit operator pin (wins outright,
 *      as long as it differs from the current model)
 *   2. strong-model candidates from constants/models.js (SSOT typed arrays —
 *      zero model-name literals here), filtered to tier T0/T1 via the
 *      modelTier resolver (same spine modelCapabilityIndex.getTier wraps)
 *
 * @param {string} currentModelId - the model being escalated AWAY from
 * @param {object} [opts]
 * @param {object} [opts.env] - Defaults to process.env
 * @returns {string|null} target model id, or null when no suitable target
 *          exists (caller must then skip the escalation — never an error)
 */
function selectTargetModel(currentModelId, opts = {}) {
  try {
    const env = (opts && opts.env) || process.env;
    const cur = String(currentModelId || '')
      .trim()
      .toLowerCase();

    // 1. Explicit operator pin.
    const pinned = String((env && env.KHY_ESCALATION_TARGET_MODEL) || '').trim();
    if (pinned && pinned.toLowerCase() !== cur) {
      return pinned;
    }

    // 2. SSOT candidates, strongest-preference order. All names come from
    //    constants/models.js — swapping a model stays a one-file edit.
    let models;
    try {
      models = require('../constants/models');
    } catch {
      return null;
    }
    let resolveTier;
    try {
      resolveTier = require('./modelTier').resolveTier;
    } catch {
      return null;
    }

    const candidates = [
      ...(models.CLAUDE_SONNET_MODELS || []),
      ...(models.RELAY_DEFAULT_MODELS || []),
      ...(models.IDE_DEFAULT_MODELS || []),
      ...(models.FREE_GROQ_MODELS || []),
    ];
    const seen = new Set();
    for (const candidate of candidates) {
      const id = String(candidate || '').trim();
      const key = id.toLowerCase();
      if (!id || key === cur || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const tier = resolveTier(id);
      if (tier === 'T0' || tier === 'T1') {
        return id;
      }
    }
    return null;
  } catch {
    return null; // fail-soft: caller skips the escalation
  }
}

module.exports = {
  createEscalationState,
  evaluate,
  selectTargetModel,
  isAutoEscalationEnabled,
};
