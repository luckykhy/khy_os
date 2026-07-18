'use strict';

/**
 * contextWindowGuard.js — Token budget enforcement and warning system.
 *
 * Ported from OpenClaw's context-window-guard.ts.
 * Evaluates context window usage and provides:
 *   - Warning when approaching limit (20% remaining)
 *   - Hard block when below minimum (10% or 4K tokens)
 *   - Oldest-first message pruning strategy
 *   - Source-aware threshold resolution
 *
 * Constants:
 *   HARD_MIN_TOKENS = 4000
 *   WARN_BELOW_TOKENS = 8000
 *   HARD_MIN_RATIO = 0.1 (10%)
 *   WARN_BELOW_RATIO = 0.2 (20%)
 */

const HARD_MIN_TOKENS = 4_000;
const WARN_BELOW_TOKENS = 8_000;
const HARD_MIN_RATIO = 0.1;
const WARN_BELOW_RATIO = 0.2;

/**
 * Resolve context window thresholds based on model context size.
 *
 * Delegates to contextProfile (the single source of truth) so the floors stay
 * proportional on small windows: the legacy `max(floor, window*ratio)` makes
 * warnBelow=8000 span the WHOLE of an 8k window and hardMin=4000 block below
 * half of it. contextProfile additionally caps each floor at a sane fraction of
 * the window, so short windows behave and large windows are byte-identical to
 * the legacy result.
 *
 * @param {number} contextWindowTokens - Total model context window
 * @returns {{ hardMinTokens: number, warnBelowTokens: number }}
 */
function resolveThresholds(contextWindowTokens) {
  return require('./contextProfile').deriveGuardThresholds(contextWindowTokens);
}

/**
 * Evaluate context window usage and determine guard actions.
 *
 * @param {object} params
 * @param {number} params.usedTokens - Tokens currently used
 * @param {number} params.contextWindowTokens - Total context window
 * @param {number} [params.warnBelowTokens] - Custom warning threshold
 * @param {number} [params.hardMinTokens] - Custom hard minimum
 * @returns {ContextGuardResult}
 */
function evaluateGuard(params) {
  const { usedTokens, contextWindowTokens } = params;
  const remaining = Math.max(0, contextWindowTokens - usedTokens);

  const defaults = resolveThresholds(contextWindowTokens);
  const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? defaults.warnBelowTokens));
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? defaults.hardMinTokens));

  return {
    usedTokens,
    remainingTokens: remaining,
    contextWindowTokens,
    hardMinTokens: hardMin,
    warnBelowTokens: warnBelow,
    usageRatio: contextWindowTokens > 0 ? usedTokens / contextWindowTokens : 1,
    shouldWarn: remaining < warnBelow,
    shouldBlock: remaining < hardMin,
  };
}

/**
 * Prune messages to fit within token budget.
 * Strategy: remove oldest non-system messages first, preserving:
 *   - System messages
 *   - Most recent N messages (minKeep)
 *   - Tool call/result pairs (don't orphan)
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} opts
 * @param {number} opts.targetTokens - Target total token count
 * @param {function} opts.estimateTokens - (text: string) => number
 * @param {number} [opts.minKeep=4] - Minimum recent messages to keep
 * @returns {{ pruned: Array, removedCount: number, removedTokens: number }}
 */
function pruneMessages(messages, opts) {
  const { targetTokens, estimateTokens, minKeep = 4 } = opts;

  // Calculate current total
  let totalTokens = 0;
  const tokenCounts = messages.map(m => {
    const count = estimateTokens(m.content || '');
    totalTokens += count;
    return count;
  });

  if (totalTokens <= targetTokens) {
    return { pruned: messages, removedCount: 0, removedTokens: 0 };
  }

  const overflow = totalTokens - targetTokens;
  let removedTokens = 0;
  let removedCount = 0;

  // Mark messages for removal (oldest first, skip system + recent)
  const keep = new Array(messages.length).fill(true);
  const protectedEnd = Math.max(0, messages.length - minKeep);

  // Pass 1: identify removable messages
  const removable = [];
  for (let i = 0; i < protectedEnd; i++) {
    const msg = messages[i];
    if (msg.role === 'system') continue; // never prune system
    removable.push(i);
  }

  // Pass 2: remove oldest until we've freed enough tokens
  for (const idx of removable) {
    if (removedTokens >= overflow) break;

    // Check tool pair integrity
    const msg = messages[idx];
    if (msg.role === 'tool') {
      // Find matching tool_call - if tool_call is kept, keep this too
      // (simplified: just remove both or neither)
      continue;
    }

    keep[idx] = false;
    removedTokens += tokenCounts[idx];
    removedCount++;

    // If this was an assistant with tool_calls, also remove tool results
    if (msg.role === 'assistant' && idx + 1 < protectedEnd && messages[idx + 1]?.role === 'tool') {
      keep[idx + 1] = false;
      removedTokens += tokenCounts[idx + 1];
      removedCount++;
    }
  }

  const pruned = messages.filter((_, i) => keep[i]);
  return { pruned, removedCount, removedTokens };
}

/**
 * Format a warning message about context window usage.
 */
function formatWarning(guard) {
  const pct = Math.round(guard.usageRatio * 100);
  return `Context window ${pct}% used (${guard.usedTokens}/${guard.contextWindowTokens} tokens). `
    + `${guard.remainingTokens} tokens remaining. `
    + (guard.shouldBlock
      ? `Below hard minimum (${guard.hardMinTokens}). Consider reducing context.`
      : `Approaching limit (warn below ${guard.warnBelowTokens}).`);
}

module.exports = {
  resolveThresholds,
  evaluateGuard,
  pruneMessages,
  formatWarning,
  HARD_MIN_TOKENS,
  WARN_BELOW_TOKENS,
  HARD_MIN_RATIO,
  WARN_BELOW_RATIO,
};
