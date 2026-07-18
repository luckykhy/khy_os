'use strict';

/**
 * contextScope/index.js — ContextScopePlanner facade.
 *
 * One entrypoint that answers: "given this task, what should I read and search,
 * accurately and without trying to be omniscient?"
 *
 * Pipeline (deterministic floor):
 *   task → extractSignals → buildIndex(.ai/) → rankCandidates
 *        → applyBudget (sufficiency stop) → buildSearchPlan → ScopePlan
 *
 * Optional model refinement: a caller may pass `modelPlanner` to prune/reorder
 * the candidate universe. By DESIGN the model can only choose WITHIN the ranked
 * candidate set and is clamped back inside the hard budget (enforceBudget).
 * It can never add files, never exceed maxFiles, and any failure/timeout falls
 * straight back to the deterministic selection.
 *
 * Defenses (防呆):
 *   ① Hard budget ceiling enforced after model refinement — model cannot expand.
 *   ② A stopReason is always present — the planner never says "read everything".
 *   ③ `.ai/` absent → empty index, plan still produced from signals + globs.
 *   ④ No hardcoded file lists — every candidate derives from signals/.ai/globs.
 *   ⑤ Model planner failure/timeout → deterministic floor; never blocks/throws.
 */

const { extractSignals } = require('./taskSignalExtractor');
const aiMapIndex = require('./aiMapIndex');
const { rankCandidates } = require('./scopeRanker');
const { applyBudget, enforceBudget } = require('./budgetController');
const { buildSearchPlan } = require('./searchPlanBuilder');

const MODEL_TIMEOUT_MS = 4000;

const _withTimeout = require('../../utils/withTimeout');

function _normaliseChosen(result) {
  if (Array.isArray(result)) return result.filter((x) => typeof x === 'string');
  if (result && Array.isArray(result.chosenPaths)) return result.chosenPaths.filter((x) => typeof x === 'string');
  return null;
}

/**
 * @param {object} input
 * @param {string} input.task            the user task / message
 * @param {string} [input.cwd]           project root (for .ai/ lookup)
 * @param {string[]} [input.recentFiles] files already in the working set
 * @param {object} [input.budget]        budgetController overrides
 * @param {function} [input.modelPlanner] async ({task,candidates,budget}) => {chosenPaths}|string[]
 * @returns {Promise<object>} ScopePlan
 */
async function planScope(input = {}) {
  const task = String(input.task || '').trim();
  const cwd = input.cwd || process.cwd();
  const recentFiles = Array.isArray(input.recentFiles) ? input.recentFiles : [];
  const budget = input.budget || {};

  const signals = extractSignals(task);
  const index = aiMapIndex.buildIndex(cwd);
  const ranked = rankCandidates(signals, index, { recentFiles });

  // Deterministic selection with mandatory sufficiency stop.
  let { selected, deferred, stopReason, confidence } = applyBudget(ranked, budget);
  let source = 'deterministic';

  // Optional model refinement — strictly within the candidate universe & budget.
  if (typeof input.modelPlanner === 'function' && ranked.length > 0) {
    const universe = ranked.slice(0, Math.max(selected.length + deferred.length, selected.length));
    const candidatesForModel = universe.map((c) => ({ path: c.path, score: c.score, reasons: c.reasons }));
    const res = await _withTimeout(
      input.modelPlanner({ task, candidates: candidatesForModel, budget: budget }),
      Number(input.modelTimeoutMs) || MODEL_TIMEOUT_MS,
    );
    const chosen = res && !res.__timeout && !res.__error ? _normaliseChosen(res) : null;
    if (chosen && chosen.length) {
      const clamped = enforceBudget(universe, chosen, { ...applyBudget([], budget).budget, ...budget });
      if (clamped.length) {
        const chosenSet = new Set(clamped.map((c) => c.path));
        selected = clamped;
        deferred = ranked.filter((c) => !chosenSet.has(c.path));
        // Confidence is signal-derived; keep the deterministic stop semantics
        // but mark that a refinement reshaped the selection.
        stopReason = 'model_refined';
        source = 'model_refined';
      }
    }
  }

  const searchPlan = buildSearchPlan(signals, {
    hasRepoCandidates: ranked.length > 0,
  });

  return {
    ok: true,
    task,
    intent: signals.intent,
    signals,
    readPlan: {
      files: selected.map((c) => ({ path: c.path, score: c.score, reasons: c.reasons })),
      deferred: deferred.slice(0, 20).map((c) => c.path),
      confidence,
      stopReason,
    },
    searchPlan,
    source,
    aiMap: { ok: index.ok, fileCount: index.fileCount, sources: index.sources || [] },
  };
}

module.exports = {
  planScope,
  // re-export internals for targeted testing / advanced callers
  extractSignals,
  aiMapIndex,
  rankCandidates,
  applyBudget,
  buildSearchPlan,
};
