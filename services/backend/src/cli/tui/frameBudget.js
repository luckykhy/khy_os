'use strict';

/**
 * frameBudget.js — rolling per-frame render-time guard for the ink TUI.
 *
 * Pure leaf: zero IO on the hot path, deterministic, never throws, env-gated.
 * Closes the gap where AGENTS.md §0.3 documents a "< 16ms single render" floor
 * but nothing in the render path actually measured it. ink 6.8.0 already emits
 * `options.onRender({ renderTime })` (ink.js:252); app.js feeds that into
 * `record()` here and the guard reports a rolling window of frame times.
 *
 * What it does:
 *   - record(renderTimeMs): append to a bounded rolling window, O(1) amortized
 *     (window is a fixed-size ring; pN is computed lazily on demand, not per
 *     frame, so the hot path stays near-zero cost).
 *   - stats(): p50 / p95 / p99 / max / count over the window.
 *   - overBudget(): whether p95 exceeds the budget (SSOT perfTunables.frameBudgetMs).
 *   - A one-time degraded-warning hook so a budget breach is surfaced ONCE to
 *     stderr (the TUI owns stdout), not spammed every frame.
 *
 * Ratchet baseline: the guard can be told to compare the current window p95
 * against a committed `tui-perf-baseline.json` (only-gets-better, mirroring
 * ruleguard-baseline.json). Absent file / absent repoRoot = no ratchet, the
 * guard still reports and warns on the absolute budget.
 */

const DEFAULT_WINDOW = 120; // ~2s at 60fps; enough for a stable p95
const MAX_RING = 4096; // hard cap so an extremely long session can't grow unbounded

/**
 * Create a frame-budget guard. Pure — no IO. Pass `budgetMs` (from
 * perfTunables.frameBudgetMs) so the guard does not re-parse env itself.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowSize=120]
 * @param {number} [opts.budgetMs=16]
 * @param {object} [opts.sink] - `{ warn(msg) }` for the one-time breach notice
 *   (defaults to a no-op; app.js injects a stderr sink so stdout stays clean).
 * @returns {object} guard
 */
function createGuard(opts = {}) {
  const cap = Math.min(Math.max(1, Math.floor(opts.windowSize || DEFAULT_WINDOW)), MAX_RING);
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 16;
  const sink = opts.sink && typeof opts.sink.warn === 'function' ? opts.sink : { warn() {} };

  const ring = new Float64Array(cap);
  let head = 0;
  let size = 0;
  let warned = false;

  /** Append a single frame duration (ms). Clamped to >= 0, finite. */
  function record(renderTimeMs) {
    const v = Number.isFinite(renderTimeMs) ? Math.max(0, renderTimeMs) : 0;
    ring[head] = v;
    head = (head + 1) % cap;
    if (size < cap) size += 1;
  }

  /** Percentile over the current window (nearest-rank). Empty window -> 0. */
  function percentile(pct) {
    if (size === 0) return 0;
    const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 95;
    const sorted = snapshot().sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[idx];
  }

  function snapshot() {
    const out = new Array(size);
    for (let i = 0; i < size; i++) {
      out[i] = ring[(head - size + i + cap) % cap];
    }
    return out;
  }

  function max() {
    let m = 0;
    for (let i = 0; i < size; i++) {
      const v = ring[(head - size + i + cap) % cap];
      if (v > m) m = v;
    }
    return m;
  }

  /**
   * Current rolling stats. Cheap: one pass to snapshot + one sort (only called
   * on demand by the scorecard / ratchet, NOT per frame).
   * @returns {{p50: number, p95: number, p99: number, max: number, count: number,
   *   overBudget: boolean, budgetMs: number}}
   */
  function stats() {
    const p95 = percentile(95);
    return {
      p50: percentile(50),
      p95,
      p99: percentile(99),
      max: max(),
      count: size,
      overBudget: p95 > budgetMs,
      budgetMs,
    };
  }

  /**
   * Emit the ONE-TIME budget-breach warning. Callers invoke this from a
   * low-frequency heartbeat (e.g. the 1s/2s status timer), never per frame.
   * Fail-soft: never throws, never writes to stdout.
   */
  function maybeWarn() {
    if (warned) return;
    const s = stats();
    if (s.count < 2 || !s.overBudget) return;
    warned = true;
    sink.warn(
      `[tui:frame] 渲染帧超预算：p95=${s.p95.toFixed(1)}ms > 预算 ${s.budgetMs}ms ` +
        `(窗口 ${s.count} 帧, max=${s.max.toFixed(1)}ms)。可调大 KHY_TUI_FRAME_BUDGET_MS，` +
        `或排查流式批量/重渲染热点。`
    );
  }

  /** Test-only: force re-arm so a second breach can be asserted. */
  function reset() {
    head = 0;
    size = 0;
    ring.fill(0);
    warned = false;
  }

  return { record, stats, maybeWarn, reset };
}

module.exports = { createGuard, DEFAULT_WINDOW, MAX_RING };
