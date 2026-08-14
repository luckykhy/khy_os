'use strict';

/**
 * toolMetricsAggregator.js — In-process, in-memory tool execution metrics.
 *
 * [C2] Pure-memory aggregation of tool call outcomes recorded at the single
 * executeTool() funnel (toolCalling.js). Keeps ONLY per-tool aggregates —
 * never per-call detail — so memory stays bounded regardless of call volume.
 *
 * Contract:
 *   - record() NEVER throws (fully swallowed) and does zero file IO.
 *   - Gating (KHY_TOOL_METRICS, default on; 0/false/off/no disables) is
 *     exposed via isMetricsEnabled() and checked by the caller BEFORE
 *     computing sizes, so a disabled gate means zero instrumentation cost.
 *   - Every EMIT_EVERY_N_RECORDS records, a summary event is emitted through
 *     the existing diagnostics channel (diagnosticEvents singleton) — no new
 *     HTTP endpoint, no timers.
 */

// ── Constants ──

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const EMIT_EVERY_N_RECORDS = 50;
// Distinct-tool cap: past this, new tool names fold into one overflow bucket
// so a pathological caller cannot grow the map unboundedly.
const MAX_DISTINCT_TOOLS = 500;
const OVERFLOW_BUCKET = '_other';

// ── State (module-singleton, in-memory only) ──

let _totalRecords = 0;
const _byTool = new Map(); // toolName → { count, successCount, totalMs, totalResultChars, errorClasses }

/**
 * Whether metrics recording is enabled. Default on; the values
 * 0 / false / off / no (case-insensitive) disable it.
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function isMetricsEnabled(env = process.env) {
  const raw = String(env.KHY_TOOL_METRICS ?? '')
    .trim()
    .toLowerCase();
  return !OFF_VALUES.has(raw);
}

/**
 * Record one tool call outcome. Aggregate-only; never throws.
 *
 * @param {object} entry
 * @param {string} entry.toolName
 * @param {boolean} entry.success
 * @param {number} entry.elapsedMs
 * @param {number} [entry.resultSizeChars]
 * @param {string} [entry.errorClass] - Coarse error class for failures
 */
function record(entry) {
  try {
    if (!entry || typeof entry.toolName !== 'string' || !entry.toolName) {
      return;
    }
    let key = entry.toolName;
    if (!_byTool.has(key) && _byTool.size >= MAX_DISTINCT_TOOLS) {
      key = OVERFLOW_BUCKET;
    }
    let bucket = _byTool.get(key);
    if (!bucket) {
      bucket = { count: 0, successCount: 0, totalMs: 0, totalResultChars: 0, errorClasses: {} };
      _byTool.set(key, bucket);
    }
    bucket.count += 1;
    if (entry.success) {
      bucket.successCount += 1;
    }
    const ms = Number(entry.elapsedMs);
    if (Number.isFinite(ms) && ms >= 0) {
      bucket.totalMs += ms;
    }
    const chars = Number(entry.resultSizeChars);
    if (Number.isFinite(chars) && chars >= 0) {
      bucket.totalResultChars += chars;
    }
    if (!entry.success && entry.errorClass) {
      const ec = String(entry.errorClass).slice(0, 80);
      bucket.errorClasses[ec] = (bucket.errorClasses[ec] || 0) + 1;
    }
    _totalRecords += 1;
    if (_totalRecords % EMIT_EVERY_N_RECORDS === 0) {
      emitSummary();
    }
  } catch {
    /* metrics must never throw */
  }
}

/**
 * Aggregated summary across all recorded tools.
 * @returns {{toolCount:number, totalCalls:number, overallSuccessRate:number, tools:Array}}
 */
function getSummary() {
  const tools = [];
  let totalCalls = 0;
  let totalSuccess = 0;
  for (const [toolName, b] of _byTool) {
    totalCalls += b.count;
    totalSuccess += b.successCount;
    tools.push({
      toolName,
      count: b.count,
      successRate: b.count > 0 ? b.successCount / b.count : 0,
      avgMs: b.count > 0 ? Math.round(b.totalMs / b.count) : 0,
      totalResultChars: b.totalResultChars,
      errorClasses: { ...b.errorClasses },
    });
  }
  return {
    toolCount: _byTool.size,
    totalCalls,
    overallSuccessRate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
    tools,
  };
}

/**
 * Emit the current summary through the existing diagnostics event channel.
 * Best-effort; failures are swallowed. Also callable on demand.
 * @returns {object|null} The emitted event, or null
 */
function emitSummary() {
  try {
    const { diagnostics } = require('./diagnosticEvents');
    const s = getSummary();
    if (s.totalCalls === 0) {
      return null;
    }
    const pct = Math.round(s.overallSuccessRate * 100);
    return diagnostics.emit('tool_metrics_summary', {
      // 动作+目标+进度:工具计量汇总 (N tools, M calls, P% success)
      message: `工具计量汇总 (${s.toolCount} tools, ${s.totalCalls} calls, ${pct}% success)`,
      toolCount: s.toolCount,
      totalCalls: s.totalCalls,
      overallSuccessRate: s.overallSuccessRate,
      tools: s.tools,
    });
  } catch {
    return null; /* diagnostics is non-critical */
  }
}

/** Reset all aggregates (test support). */
function reset() {
  _byTool.clear();
  _totalRecords = 0;
}

module.exports = {
  isMetricsEnabled,
  record,
  getSummary,
  emitSummary,
  reset,
  EMIT_EVERY_N_RECORDS,
};
