'use strict';

/**
 * loop/usage.js — whole-loop cumulative token usage (extracted verbatim from
 * toolUseLoopCore.js as the first module of the `loop/` phase decomposition).
 *
 * _tokensSpent (inside runToolUseLoop) feeds the budget governor only; these
 * helpers maintain a SEPARATE cumulative object that is returned to callers so
 * the displayed count reflects the whole loop instead of the last round.
 * Field probing order mirrors tokenBudget.extractTokenCount.
 *
 * Pure, zero-IO leaf: requires nothing from the core, so it cannot form an
 * import cycle. toolUseLoopCore re-exports _accumUsage/_cumulativeUsage from
 * here to preserve its public surface (the shim src/services/toolUseLoopCore.js
 * and existing regression tests keep working unchanged).
 */

// Fresh accumulator for one user request. Mirrors the inline literal that used
// to live at the top of runToolUseLoop's scope.
function createUsageTotals() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    rounds: 0,
  };
}

function _accumUsage(totals, u) {
  if (!totals || !u || typeof u !== 'object') {
    return;
  }
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const p = n(
    u.prompt_tokens != null
      ? u.prompt_tokens
      : u.promptTokens != null
        ? u.promptTokens
        : u.input_tokens != null
          ? u.input_tokens
          : u.inputTokens
  );
  const c = n(
    u.completion_tokens != null
      ? u.completion_tokens
      : u.completionTokens != null
        ? u.completionTokens
        : u.output_tokens != null
          ? u.output_tokens
          : u.outputTokens
  );
  let t = n(u.total_tokens != null ? u.total_tokens : u.totalTokens);
  if (!t) {
    t = p + c;
  }
  totals.promptTokens += p;
  totals.completionTokens += c;
  totals.totalTokens += t;
  // Cache billing segments (canonical khy names, Anthropic snake_case fallback)
  // — consumed downstream by contextResidentTokens.js and cacheWarning.js.
  totals.cacheReadInputTokens =
    (totals.cacheReadInputTokens || 0) +
    n(u.cacheReadInputTokens != null ? u.cacheReadInputTokens : u.cache_read_input_tokens);
  totals.cacheWriteInputTokens =
    (totals.cacheWriteInputTokens || 0) +
    n(u.cacheWriteInputTokens != null ? u.cacheWriteInputTokens : u.cache_creation_input_tokens);
  totals.rounds += 1;
}

// Build the cumulative usage payload for return sites. Falls back to the last
// round's usage object when nothing was accumulated (adapters that never
// report usage), preserving the legacy shape for those callers. Exposes both
// camelCase and snake_case keys so existing consumers (replSession reads
// inputTokens/promptTokens + outputTokens/completionTokens + totalTokens)
// match without display-layer changes.
// SEMANTICS: the returned object is the LOOP-LEVEL cumulative usage for one
// user request (rounds + cumulative:true mark it). Callers must account it
// exactly once per request — never re-accumulate it at per-iteration level.
function _cumulativeUsage(totals, lastUsage) {
  if (!totals || !totals.rounds || !totals.totalTokens) {
    return lastUsage || null;
  }
  return {
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    totalTokens: totals.totalTokens,
    inputTokens: totals.promptTokens,
    outputTokens: totals.completionTokens,
    prompt_tokens: totals.promptTokens,
    completion_tokens: totals.completionTokens,
    total_tokens: totals.totalTokens,
    cacheReadInputTokens: totals.cacheReadInputTokens || 0,
    cacheWriteInputTokens: totals.cacheWriteInputTokens || 0,
    rounds: totals.rounds,
    cumulative: true,
  };
}

module.exports = { createUsageTotals, _accumUsage, _cumulativeUsage };
