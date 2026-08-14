'use strict';

/**
 * maxTokensPolicy.js — Unified dynamic max_tokens resolution policy.
 *
 * Pure function, zero IO: callers (the generate() and generateWithAdapter()
 * preflight paths in aiGatewayGenerateMethod) feed in whatever model metadata
 * they have (context window, model output limit, prompt token estimate) and
 * get back a single deterministic decision. This replaces "user must hardcode
 * maxTokens in provider config or fall back to adapter defaults (1024 etc.)"
 * with a derive-from-known-metadata approach.
 *
 * Decision rules (in order):
 *   1. Explicit value wins; but when the context window is known and the
 *      explicit value cannot fit (explicit > contextWindow - prompt - buffer),
 *      it is safely clamped down to the available window (never raised).
 *   2. No explicit value + known context window: target =
 *      min(maxOutputTokens || available, available). When available <
 *      minCompletion the policy abstains (returns null maxTokens) so the
 *      adapter's own fallback applies — never inject a useless tiny budget.
 *   3. Unknown context window (0) + known model output limit: use the output
 *      limit as-is.
 *   4. Everything unknown: abstain (null) — unless the caller supplies a
 *      positive defaultFallback (centralized configurable floor, e.g. the
 *      KHY_DEFAULT_MAX_TOKENS flag), in which case that value is returned as
 *      source 'default_fallback'. This replaces per-adapter scattered
 *      hardcoded fallbacks with one opt-in knob; 0/absent keeps the
 *      conservative abstain semantics. It deliberately does NOT apply to the
 *      Rule 2 insufficient_window abstain: when the window is known but too
 *      tight, injecting any budget would be harmful.
 *
 * @pattern Strategy (pure decision leaf, zero IO)
 */

/** Coerce to a positive finite integer, else 0 (treated as "unknown"). */
function _pos(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Coerce to a non-negative finite integer, else 0. */
function _nonNeg(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Resolve the effective max_tokens for a request.
 *
 * @param {object} input
 * @param {number} [input.explicitMaxTokens]   Caller-supplied maxTokens (0/absent = none)
 * @param {number} [input.promptTokenEstimate] Estimated prompt tokens (0 = unknown/empty)
 * @param {number} [input.contextWindow]       Model context window (0 = unknown)
 * @param {number} [input.maxOutputTokens]     Model output token limit (0 = unknown)
 * @param {number} [input.safetyBuffer]        Tokens reserved as safety margin (default 512)
 * @param {number} [input.minCompletion]       Minimum useful completion budget (default 256)
 * @param {number} [input.defaultFallback]     Centralized fallback used ONLY when everything
 *                                             is unknown (Rule 4); 0/absent = keep abstaining
 * @param {string} [input.reason]              'preflight' | 'length_recovery' (diagnostics only)
 * @returns {{ maxTokens: number|null, source: string, clamped: boolean, diagnostics: object }}
 *   maxTokens null = abstain (caller must not inject a value).
 *   source: 'explicit' | 'explicit_clamped' | 'model_output_limit'
 *         | 'context_window' | 'insufficient_window' | 'default_fallback' | 'unknown'
 */
function resolveMaxTokens(input = {}) {
  const explicit = _pos(input.explicitMaxTokens);
  const promptEstimate = _nonNeg(input.promptTokenEstimate);
  const contextWindow = _pos(input.contextWindow);
  const maxOutputTokens = _pos(input.maxOutputTokens);
  const safetyBuffer = _nonNeg(input.safetyBuffer) || 512;
  const minCompletion = _pos(input.minCompletion) || 256;
  const defaultFallback = _pos(input.defaultFallback);
  const reason = input.reason === 'length_recovery' ? 'length_recovery' : 'preflight';

  // Available completion budget within the known context window (0 = unknown window).
  const available = contextWindow > 0 ? contextWindow - promptEstimate - safetyBuffer : 0;

  const diagnostics = {
    reason,
    explicit,
    promptEstimate,
    contextWindow,
    maxOutputTokens,
    safetyBuffer,
    minCompletion,
    defaultFallback,
    available,
  };

  // Rule 1: explicit value wins, but is clamped down when it provably overflows.
  if (explicit > 0) {
    if (contextWindow > 0 && explicit > available && available >= minCompletion) {
      return { maxTokens: available, source: 'explicit_clamped', clamped: true, diagnostics };
    }
    // Window unknown, or explicit fits, or window too tight to clamp usefully
    // (available < minCompletion → keep explicit; overflow recovery handles it).
    return { maxTokens: explicit, source: 'explicit', clamped: false, diagnostics };
  }

  // Rule 2: derive from the known context window.
  if (contextWindow > 0) {
    if (available < minCompletion) {
      // No useful budget — abstain so the adapter fallback / compaction applies.
      return { maxTokens: null, source: 'insufficient_window', clamped: false, diagnostics };
    }
    const target = maxOutputTokens > 0 ? Math.min(maxOutputTokens, available) : available;
    return {
      maxTokens: target,
      source:
        maxOutputTokens > 0 && maxOutputTokens <= available
          ? 'model_output_limit'
          : 'context_window',
      clamped: false,
      diagnostics,
    };
  }

  // Rule 3: window unknown but the model advertises an output limit.
  if (maxOutputTokens > 0) {
    return {
      maxTokens: maxOutputTokens,
      source: 'model_output_limit',
      clamped: false,
      diagnostics,
    };
  }

  // Rule 4: everything unknown — never guess a large value. When the caller
  // supplies a positive defaultFallback (centralized configurable knob), use
  // it instead of abstaining; otherwise keep the conservative null abstain so
  // adapter fallbacks stay authoritative.
  if (defaultFallback > 0) {
    return { maxTokens: defaultFallback, source: 'default_fallback', clamped: false, diagnostics };
  }
  return { maxTokens: null, source: 'unknown', clamped: false, diagnostics };
}

module.exports = { resolveMaxTokens };
