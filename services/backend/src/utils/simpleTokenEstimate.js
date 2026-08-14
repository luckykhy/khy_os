'use strict';

/**
 * simpleTokenEstimate.js — canonical truth source for the backend's quick
 * "~4 chars per token" heuristic token estimate (batch 3 convergence).
 *
 * Converges the previously scattered inline fragments (each call site kept as
 * a thin delegate; signatures and call-site guards untouched):
 *   - `Math.ceil(str.length / 4)`               → simpleTokenEstimate(str)
 *   - `Math.round(str.length / 4)`              → simpleTokenEstimate(str, { rounding: 'round' })
 *   - `Math.ceil((str.length + 3) / 4)`         → simpleTokenEstimate(str, { bias: 3 })
 *   - `Math.ceil(charCount / 4)` (pre-counted)  → simpleTokenEstimate.fromCharCount(charCount)
 *
 * Byte-for-byte equivalence proof:
 *   - fromCharCount computes `round((charCount + bias) / divisor)`. With the
 *     default bias 0, `(n + 0)` is the IEEE-754 identity for every number n
 *     (NaN propagates; Infinity preserved), so `ceil((n + 0) / 4)` is
 *     value-identical to the original inline `ceil(n / 4)` for ALL numeric
 *     inputs, not just the non-negative-integer domain of `.length`.
 *   - simpleTokenEstimate(text) reads `text.length` directly, exactly like the
 *     original inline expressions: a non-string with no numeric `length` yields
 *     `undefined + 0 → NaN → Math.ceil(NaN) = NaN`, and null/undefined throws
 *     the same TypeError the inline `.length` access threw. Deliberately NO
 *     input coercion or guarding here — every call site keeps its original
 *     guard (`String(x)`, `x || ''`, truthiness checks), preserving the exact
 *     per-site input→output mapping.
 *   - `bias: 3` reproduces `Math.ceil((len + 3) / 4)` literally (same operand
 *     order, same single division, same single rounding call).
 *   - `rounding: 'round'` swaps Math.ceil for Math.round; no other change.
 *
 * Contract: pure, deterministic, zero dependencies (safe leaf for SCC-free
 * modules such as textHeuristics), does not mutate inputs.
 *
 * @param {string} text - Text whose `.length` drives the estimate.
 * @param {object} [opts]
 * @param {number} [opts.divisor=4] - Chars-per-token divisor.
 * @param {number} [opts.bias=0] - Added to the char count before dividing.
 * @param {'ceil'|'round'} [opts.rounding='ceil'] - Rounding mode.
 * @returns {number} Estimated token count.
 */
function simpleTokenEstimate(text, opts) {
  return simpleTokenEstimateFromCharCount(text.length, opts);
}

/**
 * Same estimate for an already-counted number of characters.
 * @param {number} charCount
 * @param {object} [opts] - See simpleTokenEstimate.
 * @returns {number}
 */
function simpleTokenEstimateFromCharCount(charCount, opts = {}) {
  const divisor = opts.divisor === undefined ? 4 : opts.divisor;
  const bias = opts.bias === undefined ? 0 : opts.bias;
  const q = (charCount + bias) / divisor;
  return opts.rounding === 'round' ? Math.round(q) : Math.ceil(q);
}

module.exports = simpleTokenEstimate;
module.exports.fromCharCount = simpleTokenEstimateFromCharCount;
