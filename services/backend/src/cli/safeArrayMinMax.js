'use strict';

/**
 * safeArrayMinMax — non-spreading Math.max / Math.min over arbitrarily large
 * arrays.
 *
 * Several renderers compute a column / label width with `Math.max(...arr)`
 * (spread). When `arr` exceeds the engine's argument-stack limit (~1.3e5
 * elements) the spread throws `RangeError: Maximum call stack size exceeded` —
 * a hard, uncaught crash of the render pass. This happens on pathological model
 * output: a fenced code block with ~130 000 lines, a markdown table with
 * ~130 000 rows, or a mermaid pie/gantt/flowchart with that many segments.
 *
 * These helpers fold with a plain loop instead, so the result is numerically
 * identical to the spread for every non-crashing input, but they never overflow
 * the arg stack. Gated by KHY_SAFE_ARRAY_MINMAX (default on); off → legacy
 * spread (byte-identical output, but crashes on huge arrays — the load-bearing
 * difference).
 *
 * Pure leaf: zero IO, deterministic, gate read from the injected env.
 */

const _OFF = ['0', 'false', 'off', 'no'];

function safeArrayMinMaxEnabled(env = process.env) {
  return !_OFF.includes(
    String((env && env.KHY_SAFE_ARRAY_MINMAX) || '').trim().toLowerCase());
}

/**
 * Max of the numeric `values` together with any `floors`, without spreading.
 * Mirrors `Math.max(...floors, ...values)`: returns -Infinity for an empty
 * input, and propagates NaN exactly as Math.max would.
 *
 * @param {number[]|Iterable<number>} values
 * @param {...number} floors  extra baseline values (e.g. Math.max(20, ...arr))
 */
function maxOf(values, ...floors) {
  if (!safeArrayMinMaxEnabled()) return Math.max(...floors, ...values);
  let m = -Infinity;
  for (let i = 0; i < floors.length; i++) {
    const v = floors[i];
    if (Number.isNaN(v)) return NaN;
    if (v > m) m = v;
  }
  for (const v of values) {
    if (Number.isNaN(v)) return NaN;
    if (v > m) m = v;
  }
  return m;
}

/**
 * Min of the numeric `values` together with any `ceils`, without spreading.
 * Mirrors `Math.min(...ceils, ...values)`.
 *
 * @param {number[]|Iterable<number>} values
 * @param {...number} ceils
 */
function minOf(values, ...ceils) {
  if (!safeArrayMinMaxEnabled()) return Math.min(...ceils, ...values);
  let m = Infinity;
  for (let i = 0; i < ceils.length; i++) {
    const v = ceils[i];
    if (Number.isNaN(v)) return NaN;
    if (v < m) m = v;
  }
  for (const v of values) {
    if (Number.isNaN(v)) return NaN;
    if (v < m) m = v;
  }
  return m;
}

module.exports = { safeArrayMinMaxEnabled, maxOf, minOf };
