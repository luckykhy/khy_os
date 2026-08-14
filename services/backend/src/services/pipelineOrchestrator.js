'use strict';

/**
 * pipelineOrchestrator.js — Decision core for the small-model (T2/T3)
 * structured tool-use pipeline (plan → step → self-check → summary).
 *
 * Weak models drift in open-ended agentic loops. This module decides, per
 * loop, whether the structured pipeline is active, how often a self-check
 * checkpoint fires, and renders the checkpoint messages (delegating the
 * instruction body to services/smallModelPromptTemplates.buildPhasePrompt
 * and prepending an action+target+progress status prefix).
 *
 * Decision matrix (resolvePipelineConfig):
 *   T3                          → enabled, self-check after EVERY completed step
 *   T2 + complexityScore ≥ min  → enabled, self-check every 3rd completed step
 *   T0 / T1                     → disabled
 *   flag KHY_SMALL_MODEL_PIPELINE off → disabled for every tier
 *
 * Zero hardcoding: every threshold lives in the defaults tables below and is
 * env-overridable (KHY_SMALL_MODEL_CHECKPOINT_INTERVAL,
 * KHY_SMALL_MODEL_T2_COMPLEXITY_MIN); retryBudget / schemaLevel come from the
 * single source of truth constants/smallModelDefaults.
 *
 * Pure leaf: zero IO, deterministic, never throws. Requires only other pure
 * leaves (constants/smallModelDefaults, smallModelPromptTemplates) plus a
 * lazy fail-soft flagRegistry read (env fallback keeps the default-on
 * semantics when the registry is unavailable).
 *
 * @module services/pipelineOrchestrator
 */

const smallModelDefaults = require('../constants/smallModelDefaults');

// ── Constants (the ONLY place these values exist) ───────────────────────────

// Gate flag name (registered default-on in flagRegistry).
const PIPELINE_FLAG = 'KHY_SMALL_MODEL_PIPELINE';

// Canonical phase order (mirrors smallModelPromptTemplates.PHASES).
const PIPELINE_PHASES = Object.freeze([
  'PHASE_PLANNING',
  'PHASE_STEP_EXECUTION',
  'PHASE_SELF_CHECK',
  'PHASE_SUMMARY',
]);

// Per-tier self-check cadence: a checkpoint fires after every Nth COMPLETED
// plan step. T3 (weakest) checks every step; T2 every 3rd.
const CHECKPOINT_INTERVAL_DEFAULTS = Object.freeze({ T3: 1, T2: 3 });

// Minimum taskComplexity score for a T2 model to enter the pipeline.
const T2_COMPLEXITY_MIN_DEFAULT = 4;

// Tier names mirror services/modelTier.js (T3 = weak).
const VALID_TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);

// ── Internal helpers (never throw) ──────────────────────────────────────────

/**
 * Read the pipeline gate flag. Prefers flagRegistry (project SSOT for flag
 * semantics); falls back to a direct env read that preserves the registry's
 * default-on behavior when the registry cannot be loaded.
 * @param {object} [env] - Defaults to process.env
 * @returns {boolean}
 */
function _flagEnabled(env) {
  const e = env || process.env;
  try {
    return require('./flagRegistry').isFlagEnabled(PIPELINE_FLAG, e);
  } catch {
    const raw = String(e && e[PIPELINE_FLAG] != null ? e[PIPELINE_FLAG] : '')
      .trim()
      .toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') {
      return false;
    }
    return true; // default-on
  }
}

/**
 * Parse a scalar positive integer; invalid/missing → fallback.
 * @param {*} raw
 * @param {number} fallback
 * @returns {number}
 */
function _posIntEnv(raw, fallback) {
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Per-tier checkpoint intervals with env override.
 * Env: KHY_SMALL_MODEL_CHECKPOINT_INTERVAL — either a scalar positive integer
 * (applies to every enabled tier, e.g. '2') or a JSON partial per-tier
 * override (e.g. '{"T2":2}'). Invalid values → defaults.
 * @param {object} [env]
 * @returns {{T3:number,T2:number}}
 */
function getCheckpointIntervals(env) {
  const e = env || process.env;
  const out = { ...CHECKPOINT_INTERVAL_DEFAULTS };
  const raw = e && e.KHY_SMALL_MODEL_CHECKPOINT_INTERVAL;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) {
    return out;
  }
  if (/^\d+$/.test(s)) {
    const scalar = Number.parseInt(s, 10);
    if (Number.isFinite(scalar) && scalar >= 1) {
      out.T3 = scalar;
      out.T2 = scalar;
    }
    return out;
  }
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(out)) {
        const v = Number(parsed[key]);
        if (Number.isFinite(v) && v >= 1) {
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
 * Minimum complexity score for T2 pipeline activation.
 * Env: KHY_SMALL_MODEL_T2_COMPLEXITY_MIN — positive integer.
 * @param {object} [env]
 * @returns {number}
 */
function getT2ComplexityMin(env) {
  const e = env || process.env;
  return _posIntEnv(e && e.KHY_SMALL_MODEL_T2_COMPLEXITY_MIN, T2_COMPLEXITY_MIN_DEFAULT);
}

/**
 * Derive progress counters from a plan state ({ steps, currentStep }).
 * @param {object} planState
 * @returns {{total:number, done:number, cursor:number}}
 */
function _planProgress(planState) {
  const steps = planState && Array.isArray(planState.steps) ? planState.steps : [];
  const total = steps.length;
  const done = steps.filter((s) => s && s.status === 'completed').length;
  const raw = planState && Number.isInteger(planState.currentStep) ? planState.currentStep : 0;
  const cursor = total > 0 ? Math.min(Math.max(raw, 0), total - 1) : 0;
  return { total, done, cursor };
}

/**
 * Status prefix for a checkpoint message. Follows the project status-message
 * rule: action + target + progress (e.g. "自检: 步骤 2/5 已完成，校验结果中").
 * @param {string} phase - One of PIPELINE_PHASES
 * @param {object} planState
 * @returns {string} Empty string for unknown phase
 */
function _progressPrefix(phase, planState) {
  const { total, done, cursor } = _planProgress(planState);
  switch (phase) {
    case 'PHASE_PLANNING':
      return '[小模型流水线] 规划: 拆解任务步骤，生成执行计划中';
    case 'PHASE_STEP_EXECUTION':
      return total > 0
        ? `[小模型流水线] 执行: 步骤 ${cursor + 1}/${total} 进行中`
        : '[小模型流水线] 执行: 当前步骤进行中';
    case 'PHASE_SELF_CHECK':
      return total > 0
        ? `[小模型流水线] 自检: 步骤 ${cursor + 1}/${total} 已完成，校验结果中`
        : '[小模型流水线] 自检: 刚完成的步骤校验中';
    case 'PHASE_SUMMARY':
      return total > 0
        ? `[小模型流水线] 汇总: 计划 ${total} 步已完成 ${done} 步，生成最终总结中`
        : '[小模型流水线] 汇总: 生成最终总结中';
    default:
      return '';
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the pipeline configuration for one tool-use loop.
 *
 * @param {string} tier - 'T0'|'T1'|'T2'|'T3' (from modelTier.resolveTier;
 *   unknown values normalize to 'T2' like modelTier.harnessProfile does)
 * @param {number} complexityScore - taskComplexity score (isComplexTask().score)
 * @param {object} [opts]
 * @param {boolean} [opts.shortContext] - Model context window is tight
 * @param {object} [opts.env] - Env override for tests (defaults to process.env)
 * @returns {{tier:string, enabled:boolean, phases:string[], retryBudget:number,
 *   checkpointInterval:number, schemaLevel:('full'|'small'|'micro')}}
 */
function resolvePipelineConfig(tier, complexityScore, opts = {}) {
  const env = (opts && opts.env) || process.env;
  const t = VALID_TIERS.includes(tier) ? tier : 'T2';
  const shortContext = !!(opts && opts.shortContext);
  const score = Number(complexityScore);
  const safeScore = Number.isFinite(score) ? score : 0;

  const config = {
    tier: t,
    enabled: false,
    phases: [...PIPELINE_PHASES],
    retryBudget: 0,
    checkpointInterval: 0,
    schemaLevel: 'full',
  };
  try {
    config.retryBudget = smallModelDefaults.getRetryBudget(t, env);
    config.schemaLevel = smallModelDefaults.resolveSchemaLevel(t, shortContext, env);
  } catch {
    /* leaf getters never throw; belt-and-suspenders */
  }

  if (!_flagEnabled(env)) {
    return config;
  } // flag off → disabled for every tier

  const intervals = getCheckpointIntervals(env);
  if (t === 'T3') {
    config.enabled = true;
    config.checkpointInterval = intervals.T3;
  } else if (t === 'T2' && safeScore >= getT2ComplexityMin(env)) {
    config.enabled = true;
    config.checkpointInterval = intervals.T2;
  }
  return config;
}

/**
 * Pure verdict: is a checkpoint of `phase` admissible right now?
 *
 * PHASE_SELF_CHECK applies the cadence rule: fire when the just-completed
 * step's 1-based position is a multiple of config.checkpointInterval
 * (interval 1 → every step, 3 → steps 3/6/9…). Other known phases return
 * true — their once-per-loop / cursor cadence is caller-owned state (use
 * createCheckpointTracker() for the same-step-same-phase dedup).
 *
 * @param {object} config - From resolvePipelineConfig
 * @param {string} phase - One of PIPELINE_PHASES
 * @param {number} stepIndex - 0-based index of the just-completed plan step
 * @param {number} iterationCount - Current loop iteration (1-based)
 * @returns {boolean}
 */
function shouldInjectCheckpoint(config, phase, stepIndex, iterationCount) {
  if (!config || config.enabled !== true) {
    return false;
  }
  if (!PIPELINE_PHASES.includes(phase)) {
    return false;
  }
  const iter = Number(iterationCount);
  if (Number.isFinite(iter) && iter < 1) {
    return false;
  }
  if (phase === 'PHASE_SELF_CHECK') {
    const interval = Number(config.checkpointInterval);
    if (!Number.isFinite(interval) || interval < 1) {
      return false;
    }
    if (!Number.isInteger(stepIndex) || stepIndex < 0) {
      return false;
    }
    return (stepIndex + 1) % interval === 0;
  }
  return true;
}

/**
 * Duplicate-injection guard: remembers (phase, stepIndex) pairs so the caller
 * injects each checkpoint at most once per step.
 * @returns {{wasInjected(phase:string, stepIndex:number):boolean,
 *   markInjected(phase:string, stepIndex:number):void}}
 */
function createCheckpointTracker() {
  const seen = new Set();
  return {
    wasInjected(phase, stepIndex) {
      return seen.has(`${phase}:${stepIndex}`);
    },
    markInjected(phase, stepIndex) {
      seen.add(`${phase}:${stepIndex}`);
    },
  };
}

/**
 * Render a checkpoint message: progress-status prefix + phase instruction
 * body (delegated to smallModelPromptTemplates.buildPhasePrompt).
 *
 * @param {string} phase - One of PIPELINE_PHASES
 * @param {object} planState - { steps: Array, currentStep: number }
 *   (taskComplexity.parseExecutionPlan output plus cursor)
 * @param {object} [opts]
 * @param {string} [opts.tier] - 'T0'..'T3' (T3 selects compact templates)
 * @param {string} [opts.taskType] - 'code'|'analysis'|'dataFetch'|'general'
 * @returns {string} Empty string for unknown phase or when the template
 *   module cannot be loaded (fail-soft, never throws)
 */
function buildCheckpointMessage(phase, planState, opts = {}) {
  let body = '';
  try {
    // Lazy require: a template-module load failure degrades to '' silently.
    const templates = require('./smallModelPromptTemplates');
    body = templates.buildPhasePrompt(phase, {
      tier: opts && opts.tier,
      taskType: opts && opts.taskType,
      planState: planState || null,
    });
  } catch {
    body = '';
  }
  if (!body) {
    return '';
  }
  const prefix = _progressPrefix(phase, planState);
  return prefix ? `${prefix}\n${body}` : body;
}

module.exports = {
  PIPELINE_FLAG,
  PIPELINE_PHASES,
  CHECKPOINT_INTERVAL_DEFAULTS,
  T2_COMPLEXITY_MIN_DEFAULT,
  getCheckpointIntervals,
  getT2ComplexityMin,
  resolvePipelineConfig,
  shouldInjectCheckpoint,
  createCheckpointTracker,
  buildCheckpointMessage,
};
