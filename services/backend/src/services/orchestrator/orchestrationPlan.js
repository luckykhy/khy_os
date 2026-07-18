'use strict';

/**
 * orchestrationPlan.js — PURE LEAF (zero IO, deterministic, no Date.now/Math.random).
 *
 * Single source of truth for "express sequential / parallel / phase as ONE plan".
 * Normalizes a user workflow spec into a step DAG of {id, prompt, role, dependsOn}
 * that the thin orchestration service feeds to taskBoard (parent + children with
 * dependency edges). The three workflow shapes collapse to dependency rules:
 *
 *   sequential : step i depends on step i-1            (strict chain)
 *   parallel   : no dependencies                       (all ready at once)
 *   phase      : every step in phase k depends on ALL  (layered barrier)
 *                steps of phase k-1
 *
 * Deterministic step ids are derived from flattened order (s1, s2, ...), so the
 * leaf needs no randomness and replays byte-identically.
 *
 * This module is NET-NEW behavior gated at the command/service boundary
 * (KHY_ORCHESTRATE); the algorithm itself is unconditional pure math.
 */

const VALID_MODES = Object.freeze(['sequential', 'parallel', 'phase']);

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Normalize one raw step into the canonical step shape (minus id/dependsOn).
 * @param {object} raw
 * @returns {{prompt:string, role:string, subagentType:(string|undefined), model:(string|undefined)}}
 */
function _normalizeStep(raw, where) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`orchestration plan: ${where} must be an object with a "prompt"`);
  }
  const prompt = raw.prompt;
  if (!_isNonEmptyString(prompt)) {
    throw new Error(`orchestration plan: ${where} is missing a non-empty "prompt"`);
  }
  const role = _isNonEmptyString(raw.role) ? raw.role.trim() : 'general';
  const out = { prompt: prompt.trim(), role };
  if (_isNonEmptyString(raw.subagent_type)) out.subagentType = raw.subagent_type.trim();
  else if (_isNonEmptyString(raw.subagentType)) out.subagentType = raw.subagentType.trim();
  if (_isNonEmptyString(raw.model)) out.model = raw.model.trim();
  // Optional estimated duration (any positive unit — minutes, points, …) for the
  // 统筹/critical-path schedule analysis (criticalPathSchedule.js). Absent → the
  // schedule leaf defaults it to 1; non-numeric/negative values are ignored here
  // so an unannotated spec keeps its exact legacy shape.
  if (raw.duration !== undefined && raw.duration !== null && raw.duration !== '') {
    const d = Number(raw.duration);
    if (Number.isFinite(d) && d >= 0) out.duration = d;
  }
  return out;
}

/**
 * Build a normalized orchestration plan (a step DAG) from a workflow spec.
 *
 * @param {object} spec
 * @param {string} spec.mode - 'sequential' | 'parallel' | 'phase'
 * @param {Array}  [spec.steps]  - required for sequential/parallel
 * @param {Array}  [spec.phases] - required for phase; each {name?, steps:[...]}
 * @returns {{mode:string, steps:Array, stepCount:number, label:string}}
 */
function buildOrchestrationPlan(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('orchestration plan: spec must be an object');
  }
  const mode = _isNonEmptyString(spec.mode) ? spec.mode.trim().toLowerCase() : '';
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`orchestration plan: mode must be one of ${VALID_MODES.join('/')} (got "${spec.mode}")`);
  }

  const label = _isNonEmptyString(spec.label) ? spec.label.trim() : `orchestration-${mode}`;
  const steps = [];

  if (mode === 'phase') {
    const phases = Array.isArray(spec.phases) ? spec.phases : null;
    if (!phases || phases.length === 0) {
      throw new Error('orchestration plan: phase mode requires a non-empty "phases" array');
    }
    let prevPhaseIds = [];
    let seq = 0;
    phases.forEach((phase, pIdx) => {
      const phaseSteps = phase && Array.isArray(phase.steps) ? phase.steps : null;
      if (!phaseSteps || phaseSteps.length === 0) {
        throw new Error(`orchestration plan: phases[${pIdx}] requires a non-empty "steps" array`);
      }
      const thisPhaseIds = [];
      phaseSteps.forEach((raw) => {
        seq += 1;
        const id = `s${seq}`;
        const norm = _normalizeStep(raw, `phases[${pIdx}].steps`);
        steps.push({
          id,
          ...norm,
          phaseIndex: pIdx,
          phaseName: _isNonEmptyString(phase.name) ? phase.name.trim() : `phase-${pIdx + 1}`,
          dependsOn: prevPhaseIds.slice(),
        });
        thisPhaseIds.push(id);
      });
      prevPhaseIds = thisPhaseIds;
    });
  } else {
    const rawSteps = Array.isArray(spec.steps) ? spec.steps : null;
    if (!rawSteps || rawSteps.length === 0) {
      throw new Error(`orchestration plan: ${mode} mode requires a non-empty "steps" array`);
    }
    rawSteps.forEach((raw, i) => {
      const id = `s${i + 1}`;
      const norm = _normalizeStep(raw, `steps[${i}]`);
      const dependsOn = mode === 'sequential' && i > 0 ? [`s${i}`] : [];
      steps.push({ id, ...norm, dependsOn });
    });
  }

  return { mode, label, steps, stepCount: steps.length };
}

/**
 * Derive a stable execution summary from a plan + a map of stepId -> status.
 * Pure helper used by the monitoring view so counting logic lives in one place.
 * @param {object} plan
 * @param {Object<string,string>} statusById
 * @returns {{total:number, done:number, failed:number, running:number, pending:number}}
 */
function summarizePlanProgress(plan, statusById = {}) {
  const total = plan && Array.isArray(plan.steps) ? plan.steps.length : 0;
  let done = 0, failed = 0, running = 0, pending = 0;
  if (plan && Array.isArray(plan.steps)) {
    for (const step of plan.steps) {
      const s = statusById[step.id];
      if (s === 'done') done += 1;
      else if (s === 'blocked' || s === 'failed') failed += 1;
      else if (s === 'running') running += 1;
      else pending += 1;
    }
  }
  return { total, done, failed, running, pending };
}

module.exports = {
  VALID_MODES,
  buildOrchestrationPlan,
  summarizePlanProgress,
};
