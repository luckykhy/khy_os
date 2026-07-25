'use strict';

/**
 * clampInt.js — single source of truth for the value-based bounded-integer clamp.
 *
 * The sibling of {@link envInt} (which reads process.env by name): this one takes
 * an already-in-hand value and clamps it to `[lo, hi]`, rounding to the nearest
 * integer and falling back when the value is not finite. Two byte-identical
 * private `_clampInt(v, lo, hi, fallback)` copies (selfRepairTransaction.js,
 * memoryWriteSafety.js) drifted apart as copy-paste; both now delegate here so a
 * single definition governs the contract.
 *
 * Contract: pure, deterministic, never throws.
 *   - non-finite `v` → `fallback` (then still rounded + clamped)
 *   - result = min(hi, max(lo, round(n)))
 *
 * @param {*} v raw value (coerced via Number)
 * @param {number} lo inclusive lower bound
 * @param {number} hi inclusive upper bound
 * @param {number} fallback value used when `v` is not finite
 * @returns {number}
 */
function clampInt(v, lo, hi, fallback) {
  let n = Number(v);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.round(n);
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return n;
}

module.exports = clampInt;
