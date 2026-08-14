'use strict';

/**
 * maxTokensRecovery.js — Shared max_tokens recovery logic.
 *
 * Two-phase strategy (matching Claude Code behavior):
 *   Phase 1: Escalate from capped (≤8K) to full (64K) without changing the prompt.
 *   Phase 2: Keep 64K but inject a continuation prompt asking the model to resume.
 */

// Last-resort static fallbacks, used ONLY when the caller supplies no dynamic
// model metadata (context window / output limit unknown). Named constants, not
// policy: when dynamic bounds are available they always take precedence.
// CAPPED_DEFAULT_MAX_TOKENS — the "small cap" threshold below which Phase 1
// escalation is worthwhile; ESCALATED_MAX_TOKENS — the static escalation target.
const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
const ESCALATED_MAX_TOKENS = 64_000;
// Static attempts fallback; the effective budget is flag-driven via
// KHY_LENGTH_RECOVERY_MAX_ATTEMPTS (flagRegistry, default 3).
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
  return TRUNCATION_STOP_REASONS.has(
    String(reason || '')
      .trim()
      .toLowerCase()
  );
}

/**
 * Resolve the recovery attempt budget from the flag registry
 * (KHY_LENGTH_RECOVERY_MAX_ATTEMPTS, numeric, default 3). Fail-soft: registry
 * unavailable → the static MAX_OUTPUT_RECOVERY_ATTEMPTS fallback.
 * @returns {number}
 */
function resolveMaxRecoveryAttempts() {
  try {
    const n = require('../flagRegistry').resolveNumeric(
      'KHY_LENGTH_RECOVERY_MAX_ATTEMPTS',
      process.env
    );
    return Number.isFinite(n) && n > 0 ? n : MAX_OUTPUT_RECOVERY_ATTEMPTS;
  } catch {
    return MAX_OUTPUT_RECOVERY_ATTEMPTS;
  }
}

/**
 * Resolve the context safety buffer (shared with the gateway overflow logic,
 * KHY_CONTEXT_SAFETY_BUFFER_TOKENS, default 512). Fail-soft → 512.
 * @returns {number}
 */
function _resolveSafetyBuffer() {
  try {
    const n = require('../flagRegistry').resolveNumeric(
      'KHY_CONTEXT_SAFETY_BUFFER_TOKENS',
      process.env
    );
    return Number.isFinite(n) && n >= 0 ? n : 512;
  } catch {
    return 512;
  }
}

/**
 * Determine if max_tokens recovery should be attempted.
 *
 * @param {string} stopReason - Model's stop reason (e.g., 'max_tokens', 'length')
 * @param {number} recoveryCount - How many recovery attempts have been made so far
 * @param {number} currentMax - Current max output tokens setting
 * @param {object} [dynamic] - Optional dynamic model bounds (all fields optional):
 *   {number} [dynamic.contextWindow]   Model context window (0/absent = unknown)
 *   {number} [dynamic.maxOutputTokens] Model output token limit (0/absent = unknown)
 *   {number} [dynamic.promptEstimate]  Estimated prompt tokens (0/absent = unknown)
 * @returns {object|null} Recovery descriptor, or null if no recovery needed
 */
function shouldRecover(stopReason, recoveryCount, currentMax, dynamic = {}) {
  if (!isTruncationStop(stopReason)) {
    return null;
  }
  if (recoveryCount >= resolveMaxRecoveryAttempts()) {
    return null;
  }

  const effectiveMax = currentMax || CAPPED_DEFAULT_MAX_TOKENS;

  // Dynamic escalation ceiling: min(maxOutputTokens || static ceiling,
  // contextWindow - promptEstimate - buffer). Unknown fields fall back to the
  // static ESCALATED_MAX_TOKENS constant (legacy behavior, byte-identical when
  // no dynamic metadata is supplied).
  const dynOut = Number(dynamic && dynamic.maxOutputTokens) || 0;
  const dynWindow = Number(dynamic && dynamic.contextWindow) || 0;
  const dynPrompt = Number(dynamic && dynamic.promptEstimate) || 0;
  let ceiling = dynOut > 0 ? dynOut : ESCALATED_MAX_TOKENS;
  if (dynWindow > 0) {
    const available = dynWindow - dynPrompt - _resolveSafetyBuffer();
    if (available > 0) {
      ceiling = Math.min(ceiling, available);
    }
  }

  // Escalate whenever the ceiling is genuinely larger than the current cap —
  // NOT only when the cap is at/below CAPPED_DEFAULT_MAX_TOKENS (8000). The old
  // `effectiveMax <= CAPPED_DEFAULT_MAX_TOKENS` guard made a cap of 8192 (the
  // adapter fallback that preflight abstention leaves in place) non-escalating:
  // a truncation at 8192 kept resuming at 8192 and truncated again. As long as
  // the dynamic ceiling raises the budget, a continuation round is worth a shot
  // with more headroom (opencode philosophy: give the model its full legal
  // output budget so truncation simply does not happen).
  const shouldEscalate = ceiling > effectiveMax;

  return {
    shouldEscalate,
    nextMax: shouldEscalate ? ceiling : effectiveMax,
    recoveryCount: recoveryCount + 1,
  };
}

// How much of the already-produced text tail we echo back as the resume anchor.
// We do NOT feed the whole partial back (that invites the model to re-emit it and
// bloats the prompt) — only the tail the model needs to pick up mid-thought.
// Aligned with inertialContinuation.ANCHOR_TAIL_CHARS so both seams behave alike.
const CONTINUATION_ANCHOR_TAIL_CHARS = 320;

/**
 * Build the continuation prompt for truncated output.
 *
 * When the accumulated partial text is provided, only its TAIL is echoed back as
 * a resume anchor and the model is explicitly told to continue from the break
 * point without repeating it — so the continuation picks up mid-thought instead
 * of restarting the answer. Without partial text (or for a too-short fragment)
 * this returns the EXACT legacy from-scratch directive, so behavior is unchanged.
 *
 * @param {string} [partialText] - text already produced before truncation
 * @returns {string}
 */
function buildContinuationPrompt(partialText) {
  const partial = String(partialText == null ? '' : partialText).trim();
  if (!partial || partial.length < MIN_CONTINUATION_CHARS) {
    return '[System: Your previous response was truncated. Resume directly from where you left off without repeating any content.]';
  }
  const tail =
    partial.length > CONTINUATION_ANCHOR_TAIL_CHARS
      ? partial.slice(-CONTINUATION_ANCHOR_TAIL_CHARS)
      : partial;
  return (
    '[System: 你上一段回答因输出长度上限被截断，尚未写完。' +
    '下面方括号内是你**已经输出并已展示给用户**的结尾片段。' +
    '请从它的断点处**无缝继续**往下写：不要重复这段内容、不要重新打招呼或重写开头、' +
    '不要输出任何前言或进度说明，直接接着写完剩余部分。\n' +
    `已输出片段结尾：【…${tail}】]`
  );
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
  resolveMaxRecoveryAttempts,
  buildContinuationPrompt,
  buildTruncationNotice,
  isNegligibleContinuation,
  isRepetitiveContinuation,
  CAPPED_DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  MAX_OUTPUT_RECOVERY_ATTEMPTS,
  MIN_CONTINUATION_CHARS,
  MAX_NEGLIGIBLE_CONTINUATIONS,
  CONTINUATION_ANCHOR_TAIL_CHARS,
};
