'use strict';

/**
 * toolExecutionMetrics.js — Small-model tool-execution effect metrics (task #7).
 *
 * Aggregates tool call outcomes along the {model, toolName} dimension so the
 * small-model normalization pipeline (stages 1-4) can be measured: call count,
 * success rate, average latency, average tokens, correction rate (param-coerce
 * hits) and escalation rate (auto-escalation hand-overs).
 *
 * Contract:
 *   - record() / recordEscalation() NEVER throw and do ZERO synchronous file
 *     IO on the tool-execution hot path. Aggregation is pure in-memory; disk
 *     writes happen on a short debounced timer (clearTimeout-managed, no kill
 *     signal) or a dirty-record threshold, plus a best-effort sync write on
 *     process exit.
 *   - Persistence lives under the shared telemetry directory resolved by
 *     utils/dataHome.getDataDir('telemetry') — the SAME resolver used by
 *     telemetryService (_appRunStorePath) — never a hardcoded absolute path.
 *   - Gated by KHY_TOOL_METRICS (default on; 0/false/off/no disables), the
 *     same env switch already used by toolMetricsAggregator, so one knob
 *     controls all tool-metric collection.
 *   - Module-level singleton: state is per-process, bounded by an entry cap.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const fsp = fs.promises;

// ── Constants ──

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const STORE_FILE = 'tool_execution_metrics.json';
const STORE_VERSION = 1;
// Short debounce before persisting dirty aggregates (clearTimeout-managed
// debounce, unref'd — never keeps the process alive, never kills any work).
const FLUSH_DEBOUNCE_MS = 3_000;
// Persist immediately once this many records accumulated since last flush.
const FLUSH_RECORD_THRESHOLD = 100;
// Distinct {model, toolName} cap: past this, new pairs fold into an overflow
// bucket so a pathological caller cannot grow the map unboundedly.
const MAX_DISTINCT_ENTRIES = 800;
const OVERFLOW_MODEL = '_other';
const OVERFLOW_TOOL = '_other';
// Synthetic tool bucket used for session-level escalation events.
const ESCALATION_BUCKET = '_model_escalation';
const KEY_SEP = '\u0000';

// ── State (module singleton, in-memory only between flushes) ──

const _entries = new Map(); // `${model}\0${toolName}` → aggregate bucket
let _totalRecords = 0;
let _dirty = false;
let _dirtySinceFlush = 0;
let _flushTimer = null;
let _loaded = false;
let _exitHookInstalled = false;

/**
 * Whether metrics recording is enabled. Default on; 0/false/off/no disables.
 * Mirrors toolMetricsAggregator.isMetricsEnabled (shared KHY_TOOL_METRICS knob).
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = String(env.KHY_TOOL_METRICS ?? '')
    .trim()
    .toLowerCase();
  return !OFF_VALUES.has(raw);
}

/**
 * Resolve the persistence file path via the shared telemetry dir resolver
 * (utils/dataHome.getDataDir), mirroring telemetryService._appRunStorePath.
 * @returns {string}
 */
function _storePath() {
  try {
    const { getDataDir } = require('../utils/dataHome');
    return path.join(getDataDir('telemetry'), STORE_FILE);
  } catch {
    const fallbackDir = path.join(os.homedir(), '.khyquant', 'telemetry');
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
    } catch {
      /* ignore */
    }
    return path.join(fallbackDir, STORE_FILE);
  }
}

function _emptyBucket(tier) {
  return {
    tier: tier || null,
    count: 0,
    successCount: 0,
    totalLatencyMs: 0,
    latencyCount: 0,
    totalInputTokens: 0,
    inputTokenCount: 0,
    totalOutputTokens: 0,
    outputTokenCount: 0,
    correctedCount: 0,
    escalatedCount: 0,
    errorTypes: {},
  };
}

/** Merge a previously persisted store into the in-memory map (once, lazily). */
function _ensureLoaded() {
  if (_loaded) {
    return;
  }
  _loaded = true;
  try {
    const raw = fs.readFileSync(_storePath(), 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.entries)) {
      return;
    }
    for (const e of data.entries) {
      if (!e || typeof e.model !== 'string' || typeof e.toolName !== 'string') {
        continue;
      }
      const key = e.model + KEY_SEP + e.toolName;
      if (_entries.has(key) || _entries.size >= MAX_DISTINCT_ENTRIES) {
        continue;
      }
      const b = _emptyBucket(e.tier);
      b.count = Number(e.count) || 0;
      b.successCount = Number(e.successCount) || 0;
      b.totalLatencyMs = Number(e.totalLatencyMs) || 0;
      b.latencyCount = Number(e.latencyCount) || 0;
      b.totalInputTokens = Number(e.totalInputTokens) || 0;
      b.inputTokenCount = Number(e.inputTokenCount) || 0;
      b.totalOutputTokens = Number(e.totalOutputTokens) || 0;
      b.outputTokenCount = Number(e.outputTokenCount) || 0;
      b.correctedCount = Number(e.correctedCount) || 0;
      b.escalatedCount = Number(e.escalatedCount) || 0;
      b.errorTypes = e.errorTypes && typeof e.errorTypes === 'object' ? e.errorTypes : {};
      _entries.set(key, b);
    }
    _totalRecords = Number(data.totalRecords) || 0;
  } catch {
    /* missing/corrupt store → start fresh, never throw */
  }
}

function _serialize() {
  const entries = [];
  for (const [key, b] of _entries) {
    const sep = key.indexOf(KEY_SEP);
    entries.push({
      model: key.slice(0, sep),
      toolName: key.slice(sep + 1),
      ...b,
    });
  }
  return {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    totalRecords: _totalRecords,
    entries,
  };
}

function _installExitHook() {
  if (_exitHookInstalled) {
    return;
  }
  _exitHookInstalled = true;
  try {
    process.on('exit', () => {
      try {
        _flushSyncUnsafe();
      } catch {
        /* best-effort */
      }
    });
  } catch {
    /* hook is best-effort */
  }
}

/** Sync write used ONLY from the process exit hook (async IO impossible there). */
function _flushSyncUnsafe() {
  if (!_dirty) {
    return;
  }
  _dirty = false;
  _dirtySinceFlush = 0;
  const file = _storePath();
  fs.writeFileSync(file, JSON.stringify(_serialize()));
}

function _scheduleFlush() {
  if (_dirtySinceFlush >= FLUSH_RECORD_THRESHOLD) {
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
    void flush();
    return;
  }
  if (_flushTimer) {
    return;
  } // debounce: one pending write at a time
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
  // unref() so this single-shot debounce timer never holds the event loop /
  // process open (critical for Jest teardown — no --forceExit needed). The
  // timer still fires on its normal schedule while the process is alive, so
  // runtime flush behavior is unchanged.
  if (_flushTimer.unref) {
    _flushTimer.unref();
  }
}

/**
 * Record one tool-execution outcome. In-memory aggregation only — the disk
 * write is debounced off the hot path. NEVER throws.
 *
 * @param {object} entry
 * @param {string} [entry.model] - Executing model id
 * @param {string} [entry.tier] - Model tier (T0-T3); resolved from model when absent
 * @param {string} entry.toolName
 * @param {boolean} entry.success
 * @param {string} [entry.errorType] - Coarse error class for failures
 * @param {number} [entry.latencyMs]
 * @param {number} [entry.inputTokens]
 * @param {number} [entry.outputTokens]
 * @param {boolean} [entry.corrected] - Param-coercion applied on this call
 * @param {boolean} [entry.escalated] - Escalation event attributed to this record
 */
function record(entry) {
  try {
    if (!isEnabled(process.env)) {
      return;
    }
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const model = String(entry.model || '').trim() || '_unknown';
    const toolName = String(entry.toolName || '').trim() || '_unknown';
    let tier = String(entry.tier || '')
      .trim()
      .toUpperCase();
    if (!['T0', 'T1', 'T2', 'T3'].includes(tier)) {
      tier = '';
      if (model !== '_unknown') {
        try {
          tier = require('./modelTier').resolveTier(model) || '';
        } catch {
          /* optional */
        }
      }
    }
    _ensureLoaded();
    _installExitHook();
    let key = model + KEY_SEP + toolName;
    if (!_entries.has(key) && _entries.size >= MAX_DISTINCT_ENTRIES) {
      key = OVERFLOW_MODEL + KEY_SEP + OVERFLOW_TOOL;
    }
    let b = _entries.get(key);
    if (!b) {
      b = _emptyBucket(tier || null);
      _entries.set(key, b);
    }
    if (!b.tier && tier) {
      b.tier = tier;
    }
    b.count += 1;
    if (entry.success) {
      b.successCount += 1;
    }
    const lat = Number(entry.latencyMs);
    if (Number.isFinite(lat) && lat >= 0) {
      b.totalLatencyMs += lat;
      b.latencyCount += 1;
    }
    const inTok = Number(entry.inputTokens);
    if (Number.isFinite(inTok) && inTok >= 0) {
      b.totalInputTokens += inTok;
      b.inputTokenCount += 1;
    }
    const outTok = Number(entry.outputTokens);
    if (Number.isFinite(outTok) && outTok >= 0) {
      b.totalOutputTokens += outTok;
      b.outputTokenCount += 1;
    }
    if (entry.corrected) {
      b.correctedCount += 1;
    }
    if (entry.escalated) {
      b.escalatedCount += 1;
    }
    if (!entry.success && entry.errorType) {
      const ec = String(entry.errorType).slice(0, 80);
      b.errorTypes[ec] = (b.errorTypes[ec] || 0) + 1;
    }
    _totalRecords += 1;
    _dirty = true;
    _dirtySinceFlush += 1;
    _scheduleFlush();
  } catch {
    /* metrics must never throw nor affect tool execution */
  }
}

/**
 * Record a model-escalation event (modelSwitchManager.maybeEscalate hit).
 * Attributed to the OUTGOING model under a synthetic escalation bucket so the
 * per-model escalation rate is visible in getAggregates(). NEVER throws.
 * @param {object} event - The 'model_escalation' event built by modelSwitchManager
 */
function recordEscalation(event) {
  try {
    if (!event || typeof event !== 'object') {
      return;
    }
    record({
      model: event.fromModel,
      toolName: ESCALATION_BUCKET,
      success: true,
      escalated: true,
    });
  } catch {
    /* never throws */
  }
}

/**
 * Aggregated view across all recorded {model, toolName} pairs.
 * Rates are 0..1 fractions; averages fall back to null when no samples exist.
 * @returns {{totalRecords:number, entryCount:number, entries:Array}}
 */
function getAggregates() {
  try {
    _ensureLoaded();
    const entries = [];
    for (const [key, b] of _entries) {
      const sep = key.indexOf(KEY_SEP);
      entries.push({
        model: key.slice(0, sep),
        toolName: key.slice(sep + 1),
        tier: b.tier,
        count: b.count,
        successRate: b.count > 0 ? b.successCount / b.count : 0,
        avgLatencyMs: b.latencyCount > 0 ? Math.round(b.totalLatencyMs / b.latencyCount) : null,
        avgInputTokens:
          b.inputTokenCount > 0 ? Math.round(b.totalInputTokens / b.inputTokenCount) : null,
        avgOutputTokens:
          b.outputTokenCount > 0 ? Math.round(b.totalOutputTokens / b.outputTokenCount) : null,
        correctedRate: b.count > 0 ? b.correctedCount / b.count : 0,
        escalatedRate: b.count > 0 ? b.escalatedCount / b.count : 0,
        errorTypes: { ...b.errorTypes },
      });
    }
    return { totalRecords: _totalRecords, entryCount: _entries.size, entries };
  } catch {
    return { totalRecords: 0, entryCount: 0, entries: [] };
  }
}

/**
 * Persist dirty aggregates to the telemetry store (async, atomic tmp+rename).
 * Safe to call any time; a clean state is a no-op. NEVER throws.
 * @returns {Promise<boolean>} true when a write happened
 */
async function flush() {
  try {
    if (!_dirty) {
      return false;
    }
    _dirty = false;
    _dirtySinceFlush = 0;
    const file = _storePath();
    const tmp = `${file}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, JSON.stringify(_serialize()));
    await fsp.rename(tmp, file);
    return true;
  } catch {
    _dirty = true; // retry on next schedule
    return false;
  }
}

/**
 * Emit a 'pipeline_phase_complete' diagnostic event (task #7 helper — the
 * pipeline orchestrator itself is frozen, so completion is emitted from here
 * by whichever caller observes a checkpoint pass). Fail-soft, never throws.
 *
 * @param {object} data
 * @param {string} data.phase - Checkpoint/phase name
 * @param {number} [data.index] - 1-based phase index
 * @param {number} [data.total] - Total phases
 * @param {string} [data.tier]
 * @param {string} [data.model]
 * @param {object} [ctx] - Optional trace context ({ traceId, parentSpanId })
 * @returns {object|null} The emitted event, or null
 */
function emitPipelinePhaseComplete(data, ctx = {}) {
  try {
    if (!data || typeof data !== 'object' || !data.phase) {
      return null;
    }
    const { diagnostics } = require('./diagnosticEvents');
    const idx = Number(data.index);
    const total = Number(data.total);
    const progress =
      Number.isFinite(idx) && Number.isFinite(total) && total > 0
        ? ` (第${idx}/${total}个检查点)`
        : '';
    return diagnostics.emit(
      'pipeline_phase_complete',
      {
        // 动作+目标+进度: 小模型流水线阶段完成 <phase> (第n/m个检查点)
        message: `小模型流水线阶段完成: ${String(data.phase)}${progress}`,
        phase: String(data.phase),
        index: Number.isFinite(idx) ? idx : null,
        total: Number.isFinite(total) ? total : null,
        tier: data.tier || null,
        model: data.model || null,
      },
      ctx
    );
  } catch {
    return null; /* diagnostics is non-critical */
  }
}

/** Reset all in-memory aggregates without touching disk (test support). */
function reset() {
  _entries.clear();
  _totalRecords = 0;
  _dirty = false;
  _dirtySinceFlush = 0;
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _loaded = true; // skip re-loading persisted state after an explicit reset
}

/**
 * Cancel any pending debounced flush timer without discarding aggregates.
 * A clean teardown entry point for tests (afterAll) that lets the process
 * exit naturally; on the runtime path this is a no-op unless a flush is
 * already scheduled, so periodic flush behavior is unaffected. NEVER throws.
 * @returns {boolean} true when a pending timer was cleared
 */
function stopMetricsFlush() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
    return true;
  }
  return false;
}

module.exports = {
  isEnabled,
  record,
  recordEscalation,
  getAggregates,
  flush,
  emitPipelinePhaseComplete,
  reset,
  stopMetricsFlush,
  ESCALATION_BUCKET,
  FLUSH_DEBOUNCE_MS,
  FLUSH_RECORD_THRESHOLD,
  _storePath,
};
