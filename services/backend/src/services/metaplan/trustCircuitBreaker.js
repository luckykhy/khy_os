'use strict';

/**
 * trustCircuitBreaker.js — the trust state machine (目标11 §5 "信任熔断与强制接管").
 *
 * The anti-laziness mechanism has teeth only if a wrong "Prompt_Soft" bet has a
 * consequence. This breaker watches execution outcomes and tightens future
 * choices when the model mis-judges:
 *
 *   信任扣分 (per task-type): if the model declared Prompt_Soft but the execution
 *     then failed (e.g. a JS syntax error slipped through), that task TYPE is
 *     marked "误判风险" and every subsequent action of the same type is forced to
 *     Code_Hard — the model is no longer trusted to go naked on that kind of work.
 *
 *   会话级接管: 防呆规则 — if the model trips Prompt_Soft failures twice in a row
 *     (across any types) in this session, ALL subsequent actions are forced to
 *     Code_Hard for the rest of the session (连续 2 次翻车 → 全会话强制 Code_Hard).
 *
 * Escalation is monotone: the breaker only raises the floor via
 * `constraintStrategy.escalate`, never lowers a model's stricter choice.
 *
 * State lives per-instance (one breaker per session/coordinator); no globals.
 */

const strategy = require('./constraintStrategy');

const DEFAULT_SESSION_TRIP_THRESHOLD = 2; // 连续 Soft 翻车次数 → 全会话强制 Hard

class TrustCircuitBreaker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sessionTripThreshold]  consecutive Soft failures → session lock
   */
  constructor(opts = {}) {
    const envThresh = parseInt(process.env.KHY_METAPLAN_SESSION_TRIP || '', 10);
    this.sessionTripThreshold = Number.isFinite(opts.sessionTripThreshold)
      ? opts.sessionTripThreshold
      : (Number.isFinite(envThresh) && envThresh > 0 ? envThresh : DEFAULT_SESSION_TRIP_THRESHOLD);

    /** task types that have earned a forced Code_Hard floor. */
    this._distrustedTypes = new Set();
    /** running count of consecutive Prompt_Soft execution failures. */
    this._consecutiveSoftFailures = 0;
    /** once true, the whole session is locked to Code_Hard. */
    this._sessionLocked = false;
    /** audit trail of every adjustment the breaker made. */
    this._events = [];
  }

  /**
   * The floor this breaker currently imposes on a given task type, independent of
   * the model's choice. Returns null if no floor applies.
   * @param {string} taskType
   * @returns {(string|null)}
   */
  flooredStrategyFor(taskType) {
    if (this._sessionLocked) return strategy.STRATEGIES.CODE_HARD;
    if (this._distrustedTypes.has(_normType(taskType))) return strategy.STRATEGIES.CODE_HARD;
    return null;
  }

  /**
   * Apply the breaker's floor on top of a model's (already validated) strategy.
   * Only ever escalates.
   * @param {string} declaredStrategy   the strategy after schema validation
   * @param {string} taskType
   * @returns {{strategy:string, floored:boolean, reason:(string|null)}}
   */
  effectiveStrategy(declaredStrategy, taskType) {
    const floor = this.flooredStrategyFor(taskType);
    if (!floor) return { strategy: declaredStrategy, floored: false, reason: null };
    const eff = strategy.escalate(declaredStrategy, floor);
    const floored = eff !== declaredStrategy;
    return {
      strategy: eff,
      floored,
      reason: floored
        ? (this._sessionLocked
            ? '本会话已触发连续误判熔断，全部操作强制 Code_Hard。'
            : `任务类型「${_normType(taskType)}」此前在 Prompt_Soft 下翻车，已强制 Code_Hard。`)
        : null,
    };
  }

  /**
   * Record the outcome of an executed action so the breaker can learn.
   *
   * @param {object} outcome
   * @param {boolean} outcome.ok            did execution succeed?
   * @param {string}  outcome.declaredStrategy  what the model originally chose
   * @param {string}  [outcome.effectiveStrategy] what actually ran (post-floor)
   * @param {string}  [outcome.taskType]
   * @param {string}  [outcome.error]
   * @returns {{distrusted:boolean, sessionLocked:boolean, consecutiveSoftFailures:number}}
   */
  recordOutcome(outcome = {}) {
    const ok = !!outcome.ok;
    const declared = outcome.declaredStrategy;
    const taskType = _normType(outcome.taskType);

    // Only a Soft *bet* that then fails counts as a mis-judgment. A failure under
    // Code_Hard/System_Block is the safety net doing its job, not a trust breach.
    const wasSoftBet = declared === strategy.STRATEGIES.PROMPT_SOFT;

    if (ok) {
      // A clean success on a Soft bet restores the consecutive-failure streak.
      if (wasSoftBet) this._consecutiveSoftFailures = 0;
      return this._snapshot();
    }

    if (!wasSoftBet) {
      // Failure under a hard floor: not a trust event, leave the streak intact.
      this._events.push({ type: 'hard_failure', taskType, error: _short(outcome.error) });
      return this._snapshot();
    }

    // --- Soft bet that failed: this is the mis-judgment the breaker punishes. ---
    if (taskType) this._distrustedTypes.add(taskType);
    this._consecutiveSoftFailures += 1;
    this._events.push({
      type: 'soft_misjudgment',
      taskType,
      error: _short(outcome.error),
      consecutive: this._consecutiveSoftFailures,
    });

    if (this._consecutiveSoftFailures >= this.sessionTripThreshold && !this._sessionLocked) {
      this._sessionLocked = true;
      this._events.push({ type: 'session_lock', threshold: this.sessionTripThreshold });
    }

    return this._snapshot();
  }

  /** True if the whole session is now forced to Code_Hard. */
  isSessionLocked() {
    return this._sessionLocked;
  }

  /** Distrusted task types (copy). */
  distrustedTypes() {
    return Array.from(this._distrustedTypes);
  }

  /** Audit trail (copy). */
  events() {
    return this._events.map((e) => ({ ...e }));
  }

  _snapshot() {
    return {
      distrusted: this._distrustedTypes.size > 0,
      sessionLocked: this._sessionLocked,
      consecutiveSoftFailures: this._consecutiveSoftFailures,
    };
  }
}

function _normType(t) {
  return String(t == null ? 'default' : t).trim().toLowerCase() || 'default';
}
function _short(e) {
  return e == null ? '' : String(e).split('\n')[0].slice(0, 200);
}

module.exports = {
  TrustCircuitBreaker,
  DEFAULT_SESSION_TRIP_THRESHOLD,
};
