'use strict';

/**
 * maxTokensRecovery.js — Shared max_tokens recovery logic.
 *
 * Two-phase strategy (matching Claude Code behavior):
 *   Phase 1: Escalate from capped (≤8K) to full (64K) without changing the prompt.
 *   Phase 2: Keep 64K but inject a continuation prompt asking the model to resume.
 */

const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
const ESCALATED_MAX_TOKENS = 64_000;
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

// Diminishing-returns guard (s11). A continuation that adds almost no new text
// means the model is stuck — looping, refusing, or simply out of substance —
// and the next continuation will almost certainly be just as empty. Continuing
// only burns model calls and wall-clock. When this many *consecutive*
// continuations each add fewer than MIN_CONTINUATION_CHARS visible characters,
// recovery should stop early instead of exhausting MAX_OUTPUT_RECOVERY_ATTEMPTS.
// Both bounds are env-overridable at the call site (no hardcoding); these are
// the fallback defaults.
const MIN_CONTINUATION_CHARS = 40;
const MAX_NEGLIGIBLE_CONTINUATIONS = 2;

// Provider-native stop reasons that all mean "output hit the token cap".
// OpenAI-family adapters return 'length'; Anthropic returns 'max_tokens'.
// This mirrors the set toolUseLoop._normalizeStopReason() folds into 'length',
// so every response path detects truncation identically.
const TRUNCATION_STOP_REASONS = new Set([
  'length',
  'max_tokens',
  'max-tokens',
  'max_tokens_exceeded',
  'max_output_tokens',
  'max_completion_tokens',
]);

/**
 * Whether a provider stop reason indicates the output was truncated at the
 * token cap (as opposed to a natural stop / tool_use / error).
 *
 * @param {string} reason - Raw provider stop reason (e.g., 'length', 'max_tokens')
 * @returns {boolean}
 */
function isTruncationStop(reason) {
  return TRUNCATION_STOP_REASONS.has(String(reason || '').trim().toLowerCase());
}

/**
 * Determine if max_tokens recovery should be attempted.
 *
 * @param {string} stopReason - Model's stop reason (e.g., 'max_tokens', 'length')
 * @param {number} recoveryCount - How many recovery attempts have been made so far
 * @param {number} currentMax - Current max output tokens setting
 * @returns {object|null} Recovery descriptor, or null if no recovery needed
 */
function shouldRecover(stopReason, recoveryCount, currentMax) {
  if (!isTruncationStop(stopReason)) return null;
  if (recoveryCount >= MAX_OUTPUT_RECOVERY_ATTEMPTS) return null;

  const effectiveMax = currentMax || CAPPED_DEFAULT_MAX_TOKENS;
  const shouldEscalate = effectiveMax <= CAPPED_DEFAULT_MAX_TOKENS;

  return {
    shouldEscalate,
    nextMax: shouldEscalate ? ESCALATED_MAX_TOKENS : effectiveMax,
    recoveryCount: recoveryCount + 1,
  };
}

/**
 * Build the continuation prompt for truncated output.
 * @returns {string}
 */
function buildContinuationPrompt() {
  return '[System: Your previous response was truncated. Resume directly from where you left off without repeating any content.]';
}

/**
 * Build a short, user-facing notice appended to output that remained truncated
 * after recovery was abandoned (diminishing returns) or exhausted its attempts.
 *
 * Rationale: silently finalizing a half-sentence is the reported "截断" bug —
 * the user sees an answer cut mid-thought with no explanation. Surfacing an
 * explicit marker keeps output state transparent (no silent truncation).
 *
 * @param {number} [continuations=0] - How many continuation rounds were spent
 * @returns {string} Notice text (already prefixed with blank lines)
 */
function buildTruncationNotice(continuations = 0) {
  const n = Number.isFinite(continuations) && continuations > 0 ? continuations : 0;
  const detail = n > 0 ? `（已尝试续写 ${n} 段仍未完整）` : '';
  return `\n\n[⚠️ 输出已达长度上限被截断${detail}。可提高 maxTokens 或让我“继续”以补全剩余内容。]`;
}

/**
 * Whether a continuation chunk added so little new text that it counts as a
 * "negligible" continuation for the diminishing-returns guard.
 *
 * @param {string} text - The text produced by the latest continuation round
 * @param {number} [minChars=MIN_CONTINUATION_CHARS] - Minimum visible chars that
 *   make a continuation "productive"; anything below is negligible
 * @returns {boolean}
 */
function isNegligibleContinuation(text, minChars = MIN_CONTINUATION_CHARS) {
  const floor = Number.isFinite(minChars) && minChars > 0 ? minChars : MIN_CONTINUATION_CHARS;
  return String(text == null ? '' : text).trim().length < floor;
}

/**
 * Whether a continuation chunk is degenerate repetition (the model chanting the
 * same short fragment). Such a continuation is "productive" by character count
 * yet carries no new information, so the diminishing-returns guard must treat it
 * as negligible — otherwise truncation recovery keeps the model looping.
 *
 * Delegates to the single-source streamRepetitionGuard detector. Fail-open
 * (returns false) so a detector error never blocks recovery.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isRepetitiveContinuation(text) {
  try {
    return require('./streamRepetitionGuard').findRepetition(text).tripped;
  } catch {
    return false;
  }
}

module.exports = {
  isTruncationStop,
  shouldRecover,
  buildContinuationPrompt,
  buildTruncationNotice,
  isNegligibleContinuation,
  isRepetitiveContinuation,
  CAPPED_DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_OUTPUT_RECOVERY_ATTEMPTS,
  MIN_CONTINUATION_CHARS,
  MAX_NEGLIGIBLE_CONTINUATIONS,
};
