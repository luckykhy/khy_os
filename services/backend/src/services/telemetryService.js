/**
 * Telemetry Service — unified metrics aggregation across tools, agents, and services.
 *
 * Collects and aggregates metrics from:
 *   - Tool executions (via auditLog)
 *   - Agent runs (tradingAgentsService)
 *   - AI model usage (tokenUsageService / aiMonitor)
 *   - Service health (serviceRegistry)
 *
 * Does NOT replace individual monitoring modules — imports and composes them.
 * Provides a single getUnifiedStats() for dashboards and HUD.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

// ── In-memory counters (reset on process restart) ──────────────────

const _counters = {
  toolCalls: 0,
  toolErrors: 0,
  agentRuns: 0,
  serviceCalls: 0,
  totalLatencyMs: 0,
  startTime: Date.now(),
};

const _recentEvents = [];  // ring buffer of last N events
const MAX_RECENT = 100;

const APP_RUN_LATENCY_VERSION = 1;
const APP_RUN_MAX_SAMPLES = 256;
const CHAT_TTFT_VERSION = 1;
const CHAT_TTFT_MAX_SAMPLES = 320;

const _appRunLatencyState = {
  loaded: false,
  flushing: false,
  dirty: false,
  store: {
    version: APP_RUN_LATENCY_VERSION,
    updatedAt: null,
    apps: {},
  },
};

const _chatTtftState = {
  loaded: false,
  flushing: false,
  dirty: false,
  store: {
    version: CHAT_TTFT_VERSION,
    updatedAt: null,
    profiles: {},
  },
};

// ── Event Recording ────────────────────────────────────────────────

/**
 * Record a tool call event.
 *
 * @param {object} entry
 * @param {string} entry.tool - Tool name
 * @param {boolean} entry.success - Whether it succeeded
 * @param {number} [entry.elapsed] - Execution time in ms
 * @param {string} [entry.error] - Error message if failed
 */
function trackToolCall(entry) {
  if (!entry) return;

  _counters.toolCalls++;
  if (!entry.success) _counters.toolErrors++;
  if (entry.elapsed) _counters.totalLatencyMs += entry.elapsed;

  _pushEvent({
    type: 'tool',
    tool: entry.tool,
    success: !!entry.success,
    elapsed: entry.elapsed || 0,
    error: entry.error,
    timestamp: Date.now(),
  });
}

/**
 * Record an agent run event.
 *
 * @param {object} entry
 * @param {string} entry.agentId - Agent identifier
 * @param {string} entry.action - Action taken
 * @param {boolean} entry.success
 * @param {number} [entry.elapsed]
 */
function trackAgentRun(entry) {
  if (!entry) return;

  _counters.agentRuns++;
  if (entry.elapsed) _counters.totalLatencyMs += entry.elapsed;

  _pushEvent({
    type: 'agent',
    agentId: entry.agentId,
    action: entry.action,
    success: !!entry.success,
    elapsed: entry.elapsed || 0,
    timestamp: Date.now(),
  });
}

/**
 * Record a service call event.
 *
 * @param {object} entry
 * @param {string} entry.service - Service name
 * @param {string} entry.method - Method called
 * @param {boolean} entry.success
 * @param {number} [entry.elapsed]
 */
function trackServiceCall(entry) {
  if (!entry) return;

  _counters.serviceCalls++;
  if (entry.elapsed) _counters.totalLatencyMs += entry.elapsed;

  _pushEvent({
    type: 'service',
    service: entry.service,
    method: entry.method,
    success: !!entry.success,
    elapsed: entry.elapsed || 0,
    timestamp: Date.now(),
  });
}

// Register as the stream-health sink so the low-level SSE stale detector can
// emit health metrics WITHOUT depending on this module (dependency inversion,
// DESIGN-ARCH-051 §6.4 — breaks the gateway-adapter cluster out of the giant
// SCC). Best-effort: the sink leaf is zero-dependency and any failure here is
// non-fatal to telemetry.
try {
  require('./gateway/_streamHealthSink').setStreamHealthSink(trackServiceCall);
} catch { /* sink leaf unavailable — stream-health metrics simply not collected */ }

/**
 * Record a WASM app run latency sample and return percentile summary.
 *
 * @param {object} entry
 * @param {string} entry.app
 * @param {string} [entry.abi]
 * @param {string} [entry.exportName]
 * @param {number} entry.elapsedMs
 * @param {boolean} [entry.success=true]
 * @returns {{app:string, count:number, successCount:number, failureCount:number, lastMs:number, p50:number, p95:number}}
 */
function trackAppRunLatency(entry) {
  if (!entry || !entry.app) {
    throw new Error('trackAppRunLatency requires entry.app');
  }
  _ensureAppRunStoreLoaded();

  const appName = String(entry.app);
  const elapsedMs = _sanitizeLatencyMs(entry.elapsedMs);
  const success = entry.success !== false;

  let rec = _appRunLatencyState.store.apps[appName];
  if (!rec) {
    rec = {
      totalRuns: 0,
      failureRuns: 0,
      samplesMs: [],
      lastMs: 0,
      lastAt: null,
      lastAbi: '',
      lastExport: '',
      lastStatus: 'ok',
    };
    _appRunLatencyState.store.apps[appName] = rec;
  }

  rec.totalRuns += 1;
  if (!success) {
    rec.failureRuns += 1;
  } else {
    rec.samplesMs.push(elapsedMs);
    if (rec.samplesMs.length > APP_RUN_MAX_SAMPLES) {
      rec.samplesMs.splice(0, rec.samplesMs.length - APP_RUN_MAX_SAMPLES);
    }
  }

  rec.lastMs = elapsedMs;
  rec.lastAt = new Date().toISOString();
  rec.lastAbi = entry.abi ? String(entry.abi) : '';
  rec.lastExport = entry.exportName ? String(entry.exportName) : '';
  rec.lastStatus = success ? 'ok' : 'fail';

  _appRunLatencyState.store.updatedAt = rec.lastAt;
  _appRunLatencyState.dirty = true;
  if (process.env.NODE_ENV === 'test') {
    _flushAppRunStoreSync();
  } else {
    _flushAppRunStore().catch(() => {});
  }

  return getAppRunLatencySummary(appName);
}

/**
 * Record chat TTFT (time-to-first-token) sample and return profile summary.
 *
 * @param {object} entry
 * @param {string} [entry.profile='default']
 * @param {number} entry.elapsedMs
 * @param {boolean} [entry.success=true]
 * @param {boolean} [entry.hasFirstToken=true]
 * @param {string} [entry.adapter]
 * @param {string} [entry.errorType]
 * @returns {{profile:string,count:number,successCount:number,failureCount:number,noFirstTokenCount:number,sampleCount:number,lastMs:number,p50:number,p95:number,lastAt:string|null,lastAdapter:string,lastStatus:string}}
 */
function trackChatFirstTokenLatency(entry) {
  _ensureChatTtftStoreLoaded();

  const profile = _normalizeProfileKey(entry && entry.profile);
  const elapsedMs = _sanitizeLatencyMs(entry ? entry.elapsedMs : 0);
  const success = !entry || entry.success !== false;
  const hasFirstToken = !entry || entry.hasFirstToken !== false;
  const adapter = entry && entry.adapter ? String(entry.adapter) : '';
  const errorType = entry && entry.errorType ? String(entry.errorType) : '';

  let rec = _chatTtftState.store.profiles[profile];
  if (!rec) {
    rec = {
      totalRuns: 0,
      failureRuns: 0,
      noFirstTokenRuns: 0,
      samplesMs: [],
      lastMs: 0,
      lastAt: null,
      lastAdapter: '',
      lastErrorType: '',
      lastStatus: 'ok',
    };
    _chatTtftState.store.profiles[profile] = rec;
  }

  rec.totalRuns += 1;
  if (!success) rec.failureRuns += 1;
  if (!hasFirstToken) rec.noFirstTokenRuns += 1;

  if (hasFirstToken) {
    rec.samplesMs.push(elapsedMs);
    if (rec.samplesMs.length > CHAT_TTFT_MAX_SAMPLES) {
      rec.samplesMs.splice(0, rec.samplesMs.length - CHAT_TTFT_MAX_SAMPLES);
    }
    rec.lastMs = elapsedMs;
  }

  rec.lastAt = new Date().toISOString();
  rec.lastAdapter = adapter;
  rec.lastErrorType = errorType;
  if (!success) rec.lastStatus = 'fail';
  else if (!hasFirstToken) rec.lastStatus = 'no_first_token';
  else rec.lastStatus = 'ok';

  _chatTtftState.store.updatedAt = rec.lastAt;
  _chatTtftState.dirty = true;
  if (process.env.NODE_ENV === 'test') {
    _flushChatTtftStoreSync();
  } else {
    _flushChatTtftStore().catch(() => {});
  }

  return getChatFirstTokenLatencySummary(profile);
}

/**
 * Get TTFT summary for a profile.
 *
 * @param {string} [profile='default']
 * @returns {{profile:string,count:number,successCount:number,failureCount:number,noFirstTokenCount:number,sampleCount:number,lastMs:number,p50:number,p95:number,lastAt:string|null,lastAdapter:string,lastStatus:string}}
 */
function getChatFirstTokenLatencySummary(profile = 'default') {
  _ensureChatTtftStoreLoaded();
  const key = _normalizeProfileKey(profile);
  const rec = _chatTtftState.store.profiles[key];
  if (!rec) {
    return {
      profile: key,
      count: 0,
      successCount: 0,
      failureCount: 0,
      noFirstTokenCount: 0,
      sampleCount: 0,
      lastMs: 0,
      p50: 0,
      p95: 0,
      lastAt: null,
      lastAdapter: '',
      lastStatus: 'none',
    };
  }

  const samples = Array.isArray(rec.samplesMs) ? rec.samplesMs : [];
  const sampleCount = samples.length;
  const count = _asPositiveInt(rec.totalRuns);
  const failureCount = _asPositiveInt(rec.failureRuns);
  const noFirstTokenCount = _asPositiveInt(rec.noFirstTokenRuns);
  const successCount = Math.max(0, count - failureCount);

  return {
    profile: key,
    count,
    successCount,
    failureCount,
    noFirstTokenCount,
    sampleCount,
    lastMs: _sanitizeLatencyMs(rec.lastMs),
    p50: _percentileNearestRank(samples, 50),
    p95: _percentileNearestRank(samples, 95),
    lastAt: typeof rec.lastAt === 'string' ? rec.lastAt : null,
    lastAdapter: String(rec.lastAdapter || ''),
    lastStatus: String(rec.lastStatus || 'none'),
  };
}

/**
 * Get TTFT summaries for all profiles.
 *
 * @returns {Array<{profile:string,count:number,successCount:number,failureCount:number,noFirstTokenCount:number,sampleCount:number,lastMs:number,p50:number,p95:number,lastAt:string|null,lastAdapter:string,lastStatus:string}>}
 */
function getChatFirstTokenLatencySummaries() {
  _ensureChatTtftStoreLoaded();
  return Object.keys(_chatTtftState.store.profiles || {})
    .sort()
    .map((profile) => getChatFirstTokenLatencySummary(profile));
}

/**
 * Get app run latency summary.
 *
 * @param {string} appName
 * @returns {{app:string, count:number, successCount:number, failureCount:number, lastMs:number, p50:number, p95:number}}
 */
function getAppRunLatencySummary(appName) {
  if (!appName) {
    throw new Error('getAppRunLatencySummary requires appName');
  }
  _ensureAppRunStoreLoaded();

  const rec = _appRunLatencyState.store.apps[String(appName)];
  if (!rec) {
    return {
      app: String(appName),
      count: 0,
      successCount: 0,
      failureCount: 0,
      lastMs: 0,
      p50: 0,
      p95: 0,
    };
  }

  const samples = Array.isArray(rec.samplesMs) ? rec.samplesMs : [];
  const successCount = samples.length;
  const failureCount = _asPositiveInt(rec.failureRuns);
  const count = _asPositiveInt(rec.totalRuns);

  return {
    app: String(appName),
    count,
    successCount,
    failureCount,
    lastMs: _sanitizeLatencyMs(rec.lastMs),
    p50: _percentileNearestRank(samples, 50),
    p95: _percentileNearestRank(samples, 95),
  };
}

// ── Aggregated Statistics ──────────────────────────────────────────

/**
 * Get unified statistics across all telemetry sources.
 * Merges in-memory counters with data from auditLog and tokenUsageService.
 *
 * @returns {object} Unified stats
 */
function getUnifiedStats() {
  const uptime = Date.now() - _counters.startTime;

  // Base in-memory stats
  const stats = {
    uptime,
    uptimeFormatted: _formatDuration(uptime),
    toolCalls: _counters.toolCalls,
    toolErrors: _counters.toolErrors,
    toolSuccessRate: _counters.toolCalls > 0
      ? Math.round((_counters.toolCalls - _counters.toolErrors) / _counters.toolCalls * 100)
      : 100,
    agentRuns: _counters.agentRuns,
    serviceCalls: _counters.serviceCalls,
    avgLatency: _counters.toolCalls > 0
      ? Math.round(_counters.totalLatencyMs / _counters.toolCalls)
      : 0,
    system: {
      memoryUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      memoryTotal: Math.round(os.totalmem() / 1024 / 1024),
      cpuLoad: os.loadavg()[0],
    },
  };

  // Merge audit log stats (non-critical)
  try {
    const { getAuditStats } = require('./auditLog');
    const auditStats = getAuditStats();
    stats.audit = {
      totalCalls: auditStats.totalCalls,
      deniedCount: auditStats.deniedCount,
      topTools: Object.entries(auditStats.byTool || {})
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([name, count]) => ({ name, count })),
    };
  } catch { /* audit service not available */ }

  // Merge token usage stats (non-critical)
  try {
    const tokenUsage = require('./tokenUsageService');
    if (typeof tokenUsage.getSessionStats === 'function') {
      stats.tokens = tokenUsage.getSessionStats();
    } else if (typeof tokenUsage.getUsageSummary === 'function') {
      stats.tokens = tokenUsage.getUsageSummary();
    }
  } catch { /* token usage service not available */ }

  // Service registry stats (non-critical). Read through the zero-dependency
  // provider sink instead of importing serviceRegistry directly, so telemetry
  // stays out of the giant SCC ([DESIGN-ARCH-051] §6.7). Absence (registry not
  // loaded) leaves the field unset — same outcome as the old unavailable path.
  try {
    const sv = require('./serviceStatsSink').getServiceStats();
    if (sv) stats.services = sv;
  } catch { /* registry stats not available */ }

  return stats;
}

/**
 * Get recent events for real-time monitoring.
 *
 * @param {number} [limit=20]
 * @returns {Array}
 */
function getRecentEvents(limit = 20) {
  return _recentEvents.slice(-limit);
}

/**
 * Create dashboard data suitable for HUD or web display.
 *
 * @returns {object} Dashboard-formatted data
 */
function createDashboardData() {
  const stats = getUnifiedStats();

  // Compute per-minute rates
  const minutesUp = Math.max(1, stats.uptime / 60000);

  return {
    summary: {
      uptime: stats.uptimeFormatted,
      toolCallsPerMinute: (stats.toolCalls / minutesUp).toFixed(1),
      successRate: `${stats.toolSuccessRate}%`,
      avgLatency: `${stats.avgLatency}ms`,
      memoryUsed: `${stats.system.memoryUsed}MB`,
    },
    counters: {
      tools: stats.toolCalls,
      agents: stats.agentRuns,
      services: stats.serviceCalls,
      errors: stats.toolErrors,
    },
    topTools: stats.audit?.topTools || [],
    tokens: stats.tokens || {},
    recentEvents: getRecentEvents(10),
  };
}

/**
 * Reset all in-memory counters (for testing).
 */
function reset() {
  _counters.toolCalls = 0;
  _counters.toolErrors = 0;
  _counters.agentRuns = 0;
  _counters.serviceCalls = 0;
  _counters.totalLatencyMs = 0;
  _counters.startTime = Date.now();
  _recentEvents.length = 0;

  _appRunLatencyState.loaded = true;
  _appRunLatencyState.flushing = false;
  _appRunLatencyState.dirty = false;
  _appRunLatencyState.store = {
    version: APP_RUN_LATENCY_VERSION,
    updatedAt: null,
    apps: {},
  };

  _chatTtftState.loaded = true;
  _chatTtftState.flushing = false;
  _chatTtftState.dirty = false;
  _chatTtftState.store = {
    version: CHAT_TTFT_VERSION,
    updatedAt: null,
    profiles: {},
  };
}

// ── Internal ───────────────────────────────────────────────────────

function _pushEvent(event) {
  _recentEvents.push(event);
  if (_recentEvents.length > MAX_RECENT) {
    _recentEvents.shift();
  }
}

function _formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function _asPositiveInt(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.floor(value);
}

function _sanitizeLatencyMs(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value > 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
  return Math.round(value);
}

function _percentileNearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values
    .filter(v => Number.isFinite(v) && v >= 0)
    .map(v => Math.round(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;

  const p = Math.max(0, Math.min(100, percentile));
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function _appRunStorePath() {
  try {
    const { getDataDir } = require('../utils/dataHome');
    return path.join(getDataDir('telemetry'), 'app_run_latency.json');
  } catch {
    const fallbackDir = path.join(os.homedir(), '.khyquant', 'telemetry');
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
    return path.join(fallbackDir, 'app_run_latency.json');
  }
}

function _chatTtftStorePath() {
  try {
    const { getDataDir } = require('../utils/dataHome');
    return path.join(getDataDir('telemetry'), 'chat_ttft.json');
  } catch {
    const fallbackDir = path.join(os.homedir(), '.khyquant', 'telemetry');
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch { /* ignore */ }
    return path.join(fallbackDir, 'chat_ttft.json');
  }
}

function _normalizeProfileKey(raw) {
  const text = String(raw || 'default').trim();
  return text || 'default';
}

function _ensureAppRunStoreLoaded() {
  if (_appRunLatencyState.loaded) return;
  _appRunLatencyState.loaded = true;

  const filePath = _appRunStorePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const apps = parsed.apps && typeof parsed.apps === 'object' ? parsed.apps : {};
    _appRunLatencyState.store = {
      version: APP_RUN_LATENCY_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      apps,
    };
  } catch {
    // Keep default empty store on parse/read errors.
  }
}

function _ensureChatTtftStoreLoaded() {
  if (_chatTtftState.loaded) return;
  _chatTtftState.loaded = true;

  const filePath = _chatTtftStorePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const profiles = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
    _chatTtftState.store = {
      version: CHAT_TTFT_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      profiles,
    };
  } catch {
    // Keep default empty store on parse/read errors.
  }
}

async function _flushAppRunStore() {
  if (!_appRunLatencyState.loaded) return;
  if (_appRunLatencyState.flushing) return;
  if (!_appRunLatencyState.dirty) return;

  _appRunLatencyState.flushing = true;
  _appRunLatencyState.dirty = false;

  const payload = JSON.stringify(_appRunLatencyState.store, null, 2);
  const filePath = _appRunStorePath();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.promises.writeFile(tmpPath, payload, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch {
    // Non-critical best effort persistence.
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
  } finally {
    _appRunLatencyState.flushing = false;
    if (_appRunLatencyState.dirty) {
      await _flushAppRunStore();
    }
  }
}

function _flushAppRunStoreSync() {
  if (!_appRunLatencyState.loaded) return;
  if (!_appRunLatencyState.dirty) return;
  if (_appRunLatencyState.flushing) return;

  _appRunLatencyState.flushing = true;
  _appRunLatencyState.dirty = false;

  const payload = JSON.stringify(_appRunLatencyState.store, null, 2);
  const filePath = _appRunStorePath();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  } finally {
    _appRunLatencyState.flushing = false;
    if (_appRunLatencyState.dirty) {
      _flushAppRunStoreSync();
    }
  }
}

async function _flushChatTtftStore() {
  if (!_chatTtftState.loaded) return;
  if (_chatTtftState.flushing) return;
  if (!_chatTtftState.dirty) return;

  _chatTtftState.flushing = true;
  _chatTtftState.dirty = false;

  const payload = JSON.stringify(_chatTtftState.store, null, 2);
  const filePath = _chatTtftStorePath();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.promises.writeFile(tmpPath, payload, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  } catch {
    try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
  } finally {
    _chatTtftState.flushing = false;
    if (_chatTtftState.dirty) {
      await _flushChatTtftStore();
    }
  }
}

function _flushChatTtftStoreSync() {
  if (!_chatTtftState.loaded) return;
  if (!_chatTtftState.dirty) return;
  if (_chatTtftState.flushing) return;

  _chatTtftState.flushing = true;
  _chatTtftState.dirty = false;

  const payload = JSON.stringify(_chatTtftState.store, null, 2);
  const filePath = _chatTtftStorePath();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  } finally {
    _chatTtftState.flushing = false;
    if (_chatTtftState.dirty) {
      _flushChatTtftStoreSync();
    }
  }
}

async function _flushAppRunLatencyForTest() {
  _ensureAppRunStoreLoaded();
  if (_appRunLatencyState.dirty) {
    await _flushAppRunStore();
  }
  while (_appRunLatencyState.flushing) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function _flushChatTtftForTest() {
  _ensureChatTtftStoreLoaded();
  if (_chatTtftState.dirty) {
    await _flushChatTtftStore();
  }
  while (_chatTtftState.flushing) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── Three-Source Rollup (借鉴 DeepSeek-TUI metrics.rs 三源聚合) ──

/**
 * 审计事件记录 — append-only JSONL.
 * @param {string} event - 事件类型
 * @param {object} [details] - 事件详情
 */
function recordAuditEvent(event, details = {}) {
  try {
    const { getDataDir } = require('../utils/dataHome');
    const auditPath = path.join(getDataDir(), 'audit.log');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      event: String(event),
      details,
    });
    fs.appendFileSync(auditPath, entry + '\n');
  } catch { /* best-effort */ }
}

/**
 * 三源 Rollup — 从审计日志 + 会话文件 + 运行时内存聚合统一指标。
 *
 * @param {object} [opts]
 * @param {number} [opts.sinceMs] - 只统计此时间戳之后的事件
 * @returns {{ tools: object, agents: object, sessions: object, audit: object, period: { since: number, until: number } }}
 */
function computeRollup(opts = {}) {
  const since = opts.sinceMs || (Date.now() - 7 * 24 * 60 * 60 * 1000); // 默认 7 天
  const until = Date.now();

  const rollup = {
    tools: {}, // per-tool: { calls, successes, failures, totalMs, p50Ms, p95Ms }
    agents: { spawned: 0, succeeded: 0, failed: 0 },
    sessions: { count: 0, totalMessages: 0 },
    audit: { events: 0, byType: {} },
    period: { since, until },
  };

  // ── Source 1: 运行时内存 (当前进程的计数器) ──
  const unified = getUnifiedStats();
  for (const [name, stats] of Object.entries(unified.tools || {})) {
    rollup.tools[name] = {
      calls: stats.count || 0,
      successes: stats.successes || stats.count || 0,
      failures: stats.failures || 0,
      totalMs: stats.totalMs || 0,
      autoApproved: stats.autoApproved || 0,
      manualApproved: stats.manualApproved || 0,
    };
  }
  rollup.agents = { ...rollup.agents, ...(unified.agents || {}) };

  // ── Source 2: 审计日志 (append-only JSONL) ──
  try {
    const { getDataDir } = require('../utils/dataHome');
    const auditPath = path.join(getDataDir(), 'audit.log');
    if (fs.existsSync(auditPath)) {
      const lines = fs.readFileSync(auditPath, 'utf-8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = new Date(entry.ts).getTime();
          if (ts < since || ts > until) continue;
          rollup.audit.events++;
          const type = entry.event || 'unknown';
          rollup.audit.byType[type] = (rollup.audit.byType[type] || 0) + 1;
        } catch { /* skip corrupt */ }
      }
    }
  } catch { /* non-fatal */ }

  // ── Source 3: 会话文件 ──
  try {
    const searchIndex = require('./sessionSearchIndex');
    searchIndex.init();
    const stats = searchIndex.getStats();
    rollup.sessions.count = stats.totalSessions || 0;
    rollup.sessions.totalMessages = stats.totalMessages || 0;
  } catch { /* non-fatal */ }

  return rollup;
}

/**
 * 格式化 Rollup 为人类可读文本 (用于 `khy metrics` CLI).
 * @param {object} rollup - computeRollup 返回值
 * @returns {string}
 */
function formatRollupText(rollup) {
  const lines = [];
  const period = rollup.period || {};
  lines.push(`=== KHY 指标汇总 (${new Date(period.since).toLocaleDateString()} ~ ${new Date(period.until).toLocaleDateString()}) ===\n`);

  // Tools
  const toolEntries = Object.entries(rollup.tools || {}).sort((a, b) => b[1].calls - a[1].calls);
  if (toolEntries.length > 0) {
    lines.push('## 工具调用统计');
    lines.push('| 工具 | 调用数 | 成功 | 失败 | 总耗时(ms) |');
    lines.push('|------|--------|------|------|-----------|');
    for (const [name, s] of toolEntries.slice(0, 20)) {
      lines.push(`| ${name} | ${s.calls} | ${s.successes} | ${s.failures} | ${s.totalMs} |`);
    }
    lines.push('');
  }

  // Agents
  lines.push(`## Agent 统计\n生成: ${rollup.agents.spawned}, 成功: ${rollup.agents.succeeded}, 失败: ${rollup.agents.failed}\n`);

  // Sessions
  lines.push(`## 会话统计\n会话数: ${rollup.sessions.count}, 消息数: ${rollup.sessions.totalMessages}\n`);

  // Audit
  lines.push(`## 审计事件: ${rollup.audit.events} 条`);
  for (const [type, count] of Object.entries(rollup.audit.byType || {}).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    lines.push(`  - ${type}: ${count}`);
  }

  return lines.join('\n');
}

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  trackToolCall,
  trackAgentRun,
  trackServiceCall,
  trackAppRunLatency,
  getAppRunLatencySummary,
  trackChatFirstTokenLatency,
  getChatFirstTokenLatencySummary,
  getChatFirstTokenLatencySummaries,
  getUnifiedStats,
  getRecentEvents,
  createDashboardData,
  reset,
  // Three-source Rollup (新增)
  recordAuditEvent,
  computeRollup,
  formatRollupText,
  __flushAppRunLatencyForTest: _flushAppRunLatencyForTest,
  __flushChatTtftForTest: _flushChatTtftForTest,
};
