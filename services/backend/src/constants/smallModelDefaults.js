'use strict';

/**
 * smallModelDefaults.js — Single source of truth for small-model (T2/T3)
 * pipeline parameters.
 *
 * Every numeric threshold / budget used by the small-model normalization
 * pipeline lives here so no consumer independently hardcodes a number
 * (see AGENTS.md "Zero Hardcoding"). Every value is env-overridable; all
 * getters read env lazily on each call so tests can mutate process.env and
 * observe the change immediately.
 *
 * Pure leaf module: zero requires, zero IO, deterministic, never throws.
 * Tier names ('T0'..'T3') mirror services/modelTier.js (T3 = weak).
 *
 * @module constants/smallModelDefaults
 */

// ── Built-in defaults (the ONLY place these numbers exist) ──────────────────

// Per-tier retry budget for tool-call parameter correction loops.
const RETRY_BUDGET_DEFAULTS = { T3: 3, T2: 2, T1: 1, T0: 0 };

// Per-tier few-shot example count injected before tool-use prompts.
const FEW_SHOT_COUNT_DEFAULTS = { T3: 2, T2: 1, T1: 0, T0: 0 };

// Failure counters that trigger auto-escalation to a stronger model.
const ESCALATION_THRESHOLD_DEFAULTS = {
  toolFailureCount: 3,
  paramCorrectionRetries: 2,
  selfCheckFailures: 1,
  emptyReplyCount: 2,
};

// Maximum number of tier escalations allowed within one session.
const MAX_ESCALATIONS_DEFAULT = 2;

// Token budgets for cross-escalation context carry-forward.
const CARRYFORWARD_TOKEN_DEFAULTS = { summary: 500, carryforward: 2000 };

// Valid tool-schema compression levels (see tools/_baseTool.js toFunctionDef).
const SCHEMA_LEVELS = ['full', 'small', 'micro'];

// Max characters for the one-line tool description at the 'micro' level.
const MICRO_DESCRIPTION_MAX_CHARS_DEFAULT = 80;

// ── Internal helpers (never throw) ──────────────────────────────────────────

/**
 * Parse a JSON env var and shallow-merge its finite non-negative numeric
 * fields over `defaults`. Unknown keys, bad JSON, or non-numeric values are
 * ignored — the defaults always win on invalid input.
 * @param {string} raw - Raw env value (may be undefined/garbage)
 * @param {object} defaults - Built-in default map
 * @returns {object} Fresh merged copy (callers may mutate safely)
 */
function _mergeJsonEnv(raw, defaults) {
  const out = { ...defaults };
  if (!raw) {
    return out;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(defaults)) {
        const v = Number(parsed[key]);
        if (Number.isFinite(v) && v >= 0) {
          out[key] = Math.floor(v);
        }
      }
    }
  } catch {
    /* bad JSON → keep defaults */
  }
  return out;
}

/**
 * Parse a scalar non-negative integer env var; invalid/missing → fallback.
 * @param {string} raw
 * @param {number} fallback
 * @returns {number}
 */
function _intEnv(raw, fallback) {
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ── Public getters (lazy env reads — test-friendly) ─────────────────────────

/**
 * Per-tier retry budgets for parameter-correction loops.
 * Env: KHY_SMALL_MODEL_RETRY_BUDGET — JSON, e.g. '{"T3":5,"T2":3}'
 * (partial override; unspecified tiers keep defaults).
 * @param {object} [env] - Defaults to process.env
 * @returns {{T3:number,T2:number,T1:number,T0:number}}
 */
function getRetryBudgets(env = process.env) {
  return _mergeJsonEnv(env && env.KHY_SMALL_MODEL_RETRY_BUDGET, RETRY_BUDGET_DEFAULTS);
}

/**
 * Retry budget for a single tier. Unknown tier → the T2 (default) budget.
 * @param {string} tier - 'T0'|'T1'|'T2'|'T3'
 * @param {object} [env]
 * @returns {number}
 */
function getRetryBudget(tier, env = process.env) {
  const budgets = getRetryBudgets(env);
  return budgets[tier] !== undefined ? budgets[tier] : budgets.T2;
}

/**
 * Per-tier few-shot example counts.
 * Env: KHY_SMALL_MODEL_FEW_SHOT_COUNT — JSON, e.g. '{"T3":3}' (partial override).
 * @param {object} [env]
 * @returns {{T3:number,T2:number,T1:number,T0:number}}
 */
function getFewShotCounts(env = process.env) {
  return _mergeJsonEnv(env && env.KHY_SMALL_MODEL_FEW_SHOT_COUNT, FEW_SHOT_COUNT_DEFAULTS);
}

/**
 * Few-shot example count for a single tier. Unknown tier → 0 (no injection).
 * @param {string} tier - 'T0'|'T1'|'T2'|'T3'
 * @param {object} [env]
 * @returns {number}
 */
function getFewShotCount(tier, env = process.env) {
  const counts = getFewShotCounts(env);
  return counts[tier] !== undefined ? counts[tier] : 0;
}

/**
 * Failure thresholds that trigger auto-escalation to a stronger model.
 * Env: KHY_SMALL_MODEL_ESCALATION_THRESHOLDS — JSON, e.g. '{"toolFailureCount":5}'
 * (partial override; unspecified fields keep defaults).
 * @param {object} [env]
 * @returns {{toolFailureCount:number,paramCorrectionRetries:number,selfCheckFailures:number,emptyReplyCount:number}}
 */
function getEscalationThresholds(env = process.env) {
  return _mergeJsonEnv(
    env && env.KHY_SMALL_MODEL_ESCALATION_THRESHOLDS,
    ESCALATION_THRESHOLD_DEFAULTS
  );
}

/**
 * Maximum tier escalations allowed within one session.
 * Env: KHY_SMALL_MODEL_MAX_ESCALATIONS — non-negative integer.
 * @param {object} [env]
 * @returns {number}
 */
function getMaxEscalations(env = process.env) {
  return _intEnv(env && env.KHY_SMALL_MODEL_MAX_ESCALATIONS, MAX_ESCALATIONS_DEFAULT);
}

/**
 * Token budgets for context carry-forward across an escalation.
 * Env: KHY_SMALL_MODEL_CARRYFORWARD_TOKENS — JSON, e.g. '{"summary":800}'.
 * Scalar overrides (win over the JSON form for their own field):
 *   KHY_SMALL_MODEL_SUMMARY_TOKENS       — summary budget only
 *   KHY_SMALL_MODEL_CARRYFORWARD_BUDGET  — carryforward budget only
 * @param {object} [env]
 * @returns {{summary:number,carryforward:number}}
 */
function getCarryForwardTokenBudgets(env = process.env) {
  const merged = _mergeJsonEnv(
    env && env.KHY_SMALL_MODEL_CARRYFORWARD_TOKENS,
    CARRYFORWARD_TOKEN_DEFAULTS
  );
  merged.summary = _intEnv(env && env.KHY_SMALL_MODEL_SUMMARY_TOKENS, merged.summary);
  merged.carryforward = _intEnv(
    env && env.KHY_SMALL_MODEL_CARRYFORWARD_BUDGET,
    merged.carryforward
  );
  return merged;
}

/**
 * Max characters for the one-line tool description at schema level 'micro'.
 * Env: KHY_SMALL_MODEL_MICRO_DESC_MAX — positive integer.
 * @param {object} [env]
 * @returns {number}
 */
function getMicroDescriptionMaxChars(env = process.env) {
  const n = _intEnv(env && env.KHY_SMALL_MODEL_MICRO_DESC_MAX, MICRO_DESCRIPTION_MAX_CHARS_DEFAULT);
  return n > 0 ? n : MICRO_DESCRIPTION_MAX_CHARS_DEFAULT;
}

/**
 * Resolve the tool-schema compression level for a model tier.
 *
 * Matrix:  T3 + shortContext → 'micro';  T3 → 'small';
 *          T2 + shortContext → 'small';  everything else → 'full'.
 * Env: KHY_SMALL_MODEL_SCHEMA_LEVEL — global force ('full'|'small'|'micro');
 * a valid value wins over the matrix, an invalid value is ignored.
 *
 * @param {string} tier - 'T0'|'T1'|'T2'|'T3' (from modelTier.resolveTier)
 * @param {boolean} [shortContext] - True when the model context window is tight
 * @param {object} [env]
 * @returns {'full'|'small'|'micro'}
 */
function resolveSchemaLevel(tier, shortContext = false, env = process.env) {
  const forced = String((env && env.KHY_SMALL_MODEL_SCHEMA_LEVEL) || '')
    .trim()
    .toLowerCase();
  if (SCHEMA_LEVELS.includes(forced)) {
    return forced;
  }
  if (tier === 'T3') {
    return shortContext ? 'micro' : 'small';
  }
  if (tier === 'T2' && shortContext) {
    return 'small';
  }
  return 'full';
}

module.exports = {
  // Built-in default tables (read-only reference; use the getters at runtime)
  RETRY_BUDGET_DEFAULTS: Object.freeze({ ...RETRY_BUDGET_DEFAULTS }),
  FEW_SHOT_COUNT_DEFAULTS: Object.freeze({ ...FEW_SHOT_COUNT_DEFAULTS }),
  ESCALATION_THRESHOLD_DEFAULTS: Object.freeze({ ...ESCALATION_THRESHOLD_DEFAULTS }),
  MAX_ESCALATIONS_DEFAULT,
  CARRYFORWARD_TOKEN_DEFAULTS: Object.freeze({ ...CARRYFORWARD_TOKEN_DEFAULTS }),
  MICRO_DESCRIPTION_MAX_CHARS_DEFAULT,
  SCHEMA_LEVELS: Object.freeze([...SCHEMA_LEVELS]),
  // Lazy env-aware getters
  getRetryBudgets,
  getRetryBudget,
  getFewShotCounts,
  getFewShotCount,
  getEscalationThresholds,
  getMaxEscalations,
  getCarryForwardTokenBudgets,
  getMicroDescriptionMaxChars,
  resolveSchemaLevel,
};
