'use strict';

/**
 * slowRequestCore.js — 纯叶子(zero-IO, 确定性):慢请求告警背后的全部纯逻辑。
 *
 * 设计对齐 cli/heapDump.js 的「纯叶子 + 薄壳」范式:阈值判定、采样决策、
 * 路由键归一与基数封顶、聚合合并、分位计算、告警措辞、分片保留期计算
 * 全在这里 —— 确定性、零 IO、零业务 require;所有外部量(now / env /
 * 已知路由集合)都由薄壳 slowRequest.js 注入。真正写盘(JSONL / telemetry
 * store)、发事件(eventLog)、打日志是副作用,留在薄壳。
 *
 * 阈值单一真源:constants/serviceDefaults.js 的 OBSERVABILITY 块提供默认值,
 * resolveConfig() 在其上叠加 env 覆盖(所以测试改 env 无需重载模块)。
 *
 * 默认关闭:OBSERVABILITY.SLOW_REQUEST_ENABLED 默认 false —— 未开启时
 * 薄壳在 res.on('finish') 里只做一次布尔判断,零额外开销。
 */

const { OBSERVABILITY } = require('../constants/serviceDefaults');

const DAY_MS = 24 * 60 * 60 * 1000;
/** 基数封顶溢出桶名 — 与 toolExecutionMetrics 的 OVERFLOW_TOOL 同构。 */
const OVERFLOW_ROUTE = '_other';

function _int(raw, fallback) {
  const n = parseInt(String(raw == null ? '' : raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _bool(raw, fallback) {
  if (raw == null || raw === '') {
    return fallback;
  }
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(v)) {
    return false;
  }
  if (['1', 'true', 'on', 'yes'].includes(v)) {
    return true;
  }
  return fallback;
}

/**
 * 解析生效配置:serviceDefaults 默认值 + env 覆盖。纯函数(env 由调用方注入)。
 *
 * @param {object} [env=process.env]
 * @returns {{enabled:boolean,thresholdMs:number,sampleRate:number,cooldownMs:number,
 *            maxRoutes:number,maxSamples:number,retentionDays:number}}
 */
function resolveConfig(env = process.env) {
  const e = env || {};
  const sampleRaw = Number(
    e.KHY_SLOW_REQUEST_SAMPLE_RATE != null && e.KHY_SLOW_REQUEST_SAMPLE_RATE !== ''
      ? e.KHY_SLOW_REQUEST_SAMPLE_RATE
      : OBSERVABILITY.SLOW_REQUEST_SAMPLE_RATE
  );
  return {
    enabled: _bool(e.KHY_SLOW_REQUEST_ENABLED, OBSERVABILITY.SLOW_REQUEST_ENABLED),
    thresholdMs: Math.max(
      1,
      _int(e.KHY_SLOW_REQUEST_THRESHOLD_MS, OBSERVABILITY.SLOW_REQUEST_THRESHOLD_MS)
    ),
    sampleRate: Number.isFinite(sampleRaw) ? Math.max(0, Math.min(1, sampleRaw)) : 1,
    cooldownMs: Math.max(
      0,
      _int(e.KHY_SLOW_REQUEST_ALERT_COOLDOWN_MS, OBSERVABILITY.SLOW_REQUEST_ALERT_COOLDOWN_MS)
    ),
    maxRoutes: Math.max(
      1,
      _int(e.KHY_SLOW_REQUEST_MAX_ROUTES, OBSERVABILITY.SLOW_REQUEST_MAX_ROUTES)
    ),
    maxSamples: Math.max(
      1,
      _int(e.KHY_SLOW_REQUEST_MAX_SAMPLES, OBSERVABILITY.SLOW_REQUEST_MAX_SAMPLES)
    ),
    retentionDays: Math.max(
      1,
      _int(e.KHY_SLOW_REQUEST_RETENTION_DAYS, OBSERVABILITY.SLOW_REQUEST_RETENTION_DAYS)
    ),
  };
}

/**
 * 上限参数的统一兜底:省略或非法时退回 SSOT 默认值,而不是退回 1。
 *
 * 这条兜底很关键 —— 早期实现写的是 `Math.max(1, Number(x) || 1)`,调用方一旦
 * 省略 maxSamples,样本环就悄悄缩到 1,p50/p95 全都退化成「最后一次的值」,
 * 而 totalSlow/todayCount 看上去仍然正常,故障完全没有表面症状。
 */
function _capOrDefault(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) {
    return Math.floor(n);
  }
  return Math.max(1, Math.floor(Number(fallback) || 1));
}

/** 慢判定 — 严格 >= 阈值算慢(阈值本身即「不可接受」的边界)。 */
function isSlow(durationMs, thresholdMs) {
  const d = Number(durationMs);
  const t = Number(thresholdMs);
  if (!Number.isFinite(d) || !Number.isFinite(t)) {
    return false;
  }
  return d >= t;
}

/**
 * 确定性采样 — token-bucket 累加器,不用 Math.random(可单测、可复现)。
 * rate=1 → 每次都采;rate=0.25 → 每 4 次采 1 次。state 由调用方持有。
 *
 * @param {number} sampleRate 0..1
 * @param {{acc:number}} state 累加器(原地更新)
 * @returns {boolean}
 */
function shouldSample(sampleRate, state) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    return false;
  }
  if (rate >= 1) {
    return true;
  }
  const s = state && typeof state === 'object' ? state : { acc: 0 };
  s.acc = (Number.isFinite(s.acc) ? s.acc : 0) + rate;
  if (s.acc >= 1) {
    s.acc -= 1;
    return true;
  }
  return false;
}

/**
 * 本地日键 YYYY-MM-DD(不用 toISOString —— 那是 UTC,会让 UTC+8 用户看到的
 * 「今日第 N 次」在本地早上 8 点才归零)。eventLog 的分片仍是 UTC,两者
 * 刻意不同:eventLog 是机器侧账本,本模块的日键是面向用户的「今日」。
 */
function dayKey(now) {
  const n = Number(now);
  const d = new Date(Number.isFinite(n) && n >= 0 ? n : 0);
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 路由键 = 「METHOD 归一化路径」。归一化由 metrics.normalizePath 上游完成。 */
function buildRouteKey(method, normalizedPath) {
  const m = String(method || 'GET')
    .trim()
    .toUpperCase()
    .slice(0, 10);
  const p = String(normalizedPath || '/').trim() || '/';
  return `${m} ${p}`;
}

/**
 * 基数封顶:已知路由未满 maxRoutes 时原样返回;否则新路由归入 `_other`。
 * 防止 path 归一化失效时把 store 撑爆(与 toolExecutionMetrics 同策略)。
 *
 * maxRoutes 省略时退回 SSOT 默认值 —— 不传封顶参数不等于「不封顶」。
 */
function selectRouteKey(routeKey, knownKeys, maxRoutes) {
  const key = String(routeKey || '');
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys || []);
  if (known.has(key)) {
    return key;
  }
  const cap = _capOrDefault(maxRoutes, OBSERVABILITY.SLOW_REQUEST_MAX_ROUTES);
  if (known.size >= cap) {
    return OVERFLOW_ROUTE;
  }
  return key;
}

function _sanitizeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.min(Math.round(n), DAY_MS);
}

/**
 * 组装一条慢请求明细记录(即落 .khy/monitor/slow-<day>.jsonl 的那一行,
 * 也是 eventLog `perf.slow_request` 事件的 payload)。
 */
function buildRecord(p = {}) {
  const now = Number.isFinite(Number(p.now)) ? Number(p.now) : 0;
  return {
    ts: new Date(now).toISOString(),
    day: dayKey(now),
    method: String(p.method || 'GET').toUpperCase(),
    path: String(p.path || '/'),
    route: buildRouteKey(p.method, p.path),
    durationMs: _sanitizeMs(p.durationMs),
    thresholdMs: _sanitizeMs(p.thresholdMs),
    statusCode: String(p.statusCode == null ? '' : p.statusCode),
    requestId: String(p.requestId == null ? '' : p.requestId),
    traceId: String(p.traceId == null ? '' : p.traceId),
    todayCount: Math.max(0, Math.floor(Number(p.todayCount) || 0)),
  };
}

/** 空路由聚合槽。 */
function emptyRouteRecord() {
  return {
    totalSlow: 0,
    todayKey: '',
    todayCount: 0,
    samplesMs: [],
    lastMs: 0,
    maxMs: 0,
    lastAt: null,
    lastStatus: '',
    lastAlertAt: 0,
  };
}

/**
 * 把一条明细并入路由聚合槽(原地更新并返回)。跨日自动重置 todayCount。
 * 样本环有界(maxSamples),超出从头丢弃 —— 与 telemetryService TTFT 同策略。
 * maxSamples 省略时退回 SSOT 默认值(见 _capOrDefault 的说明)。
 */
function mergeSummary(routeRec, record, maxSamples) {
  const rec =
    routeRec && typeof routeRec === 'object' ? routeRec : emptyRouteRecord();
  if (!Array.isArray(rec.samplesMs)) {
    rec.samplesMs = [];
  }

  const day = String(record && record.day ? record.day : '');
  if (rec.todayKey !== day) {
    rec.todayKey = day;
    rec.todayCount = 0;
  }
  rec.todayCount += 1;
  rec.totalSlow = Math.max(0, Math.floor(Number(rec.totalSlow) || 0)) + 1;

  const ms = _sanitizeMs(record && record.durationMs);
  rec.samplesMs.push(ms);
  const cap = _capOrDefault(maxSamples, OBSERVABILITY.SLOW_REQUEST_MAX_SAMPLES);
  if (rec.samplesMs.length > cap) {
    rec.samplesMs.splice(0, rec.samplesMs.length - cap);
  }

  rec.lastMs = ms;
  rec.maxMs = Math.max(_sanitizeMs(rec.maxMs), ms);
  rec.lastAt = record && record.ts ? String(record.ts) : rec.lastAt;
  rec.lastStatus = record && record.statusCode ? String(record.statusCode) : rec.lastStatus;
  return rec;
}

/** nearest-rank 分位 — 与 telemetryService._percentileNearestRank 同算法。 */
function percentileNearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  const sorted = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .map((v) => Math.round(v))
    .sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  const p = Math.max(0, Math.min(100, Number(percentile) || 0));
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** 路由聚合槽 → 对外只读摘要(CLI / dashboard 消费)。 */
function summarizeRoute(routeKey, routeRec) {
  const rec = routeRec && typeof routeRec === 'object' ? routeRec : emptyRouteRecord();
  const samples = Array.isArray(rec.samplesMs) ? rec.samplesMs : [];
  return {
    route: String(routeKey || ''),
    totalSlow: Math.max(0, Math.floor(Number(rec.totalSlow) || 0)),
    todayKey: String(rec.todayKey || ''),
    todayCount: Math.max(0, Math.floor(Number(rec.todayCount) || 0)),
    sampleCount: samples.length,
    lastMs: _sanitizeMs(rec.lastMs),
    maxMs: _sanitizeMs(rec.maxMs),
    p50: percentileNearestRank(samples, 50),
    p95: percentileNearestRank(samples, 95),
    lastAt: typeof rec.lastAt === 'string' ? rec.lastAt : null,
    lastStatus: String(rec.lastStatus || ''),
  };
}

/**
 * 告警去抖:同一路由在 cooldownMs 内只喊一次(慢请求常成批出现,
 * 逐条刷屏会把真正的信号淹掉)。cooldown=0 → 每条都喊。
 */
function shouldAlert(lastAlertAt, now, cooldownMs) {
  const last = Number(lastAlertAt);
  const n = Number(now);
  const cd = Number(cooldownMs);
  if (!Number.isFinite(n)) {
    return false;
  }
  if (!Number.isFinite(last) || last <= 0) {
    return true;
  }
  if (!Number.isFinite(cd) || cd <= 0) {
    return true;
  }
  return n - last >= cd;
}

/** 毫秒 → 「8.2s」/「850ms」(告警文案用,秒级保留一位小数)。 */
function formatDuration(ms) {
  const n = _sanitizeMs(ms);
  if (n < 1000) {
    return `${n}ms`;
  }
  return `${(n / 1000).toFixed(1)}s`;
}

/**
 * 告警文案 —— 严格遵守 AGENTS.md 规则 2「动作 + 目标 + 进度」:
 *   动作 = 慢请求;目标 = POST /api/backtest;进度 = 耗时/阈值/今日第 N 次。
 * 例:慢请求 POST /api/backtest/#path 耗时 8.2s,超阈值 3.0s,今日第 4 次
 */
function formatAlert(record = {}) {
  const method = String(record.method || 'GET').toUpperCase();
  const p = String(record.path || '/');
  const count = Math.max(1, Math.floor(Number(record.todayCount) || 1));
  const status = String(record.statusCode || '');
  const statusPart = status ? `,状态码 ${status}` : '';
  return (
    `慢请求 ${method} ${p} 耗时 ${formatDuration(record.durationMs)},` +
    `超阈值 ${formatDuration(record.thresholdMs)},今日第 ${count} 次${statusPart}`
  );
}

/** 明细分片文件名(本地日)。 */
function shardFileName(day) {
  return `slow-${String(day || '')}.jsonl`;
}

const _SHARD_RE = /^slow-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 从分片文件名解出日键;不匹配返回 null。 */
function parseShardDay(fileName) {
  const m = _SHARD_RE.exec(String(fileName || ''));
  return m ? m[1] : null;
}

/**
 * 计算超出保留期、可删除的分片文件名(纯函数,不碰文件系统)。
 * 非 slow-*.jsonl 的文件一律不返回 —— MonitorTool 的 mon-*.log 绝不会被误删。
 *
 * @param {string[]} fileNames 目录下的文件名列表
 * @param {string} todayKey 今天的日键 YYYY-MM-DD
 * @param {number} retentionDays 保留天数(含今天)
 * @returns {string[]}
 */
function expiredShards(fileNames, todayKey, retentionDays) {
  const days = Math.max(1, Math.floor(Number(retentionDays) || 1));
  const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(todayMs)) {
    return [];
  }
  const cutoff = todayMs - (days - 1) * DAY_MS;
  const out = [];
  for (const name of Array.isArray(fileNames) ? fileNames : []) {
    const day = parseShardDay(name);
    if (!day) {
      continue;
    }
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(ms) && ms < cutoff) {
      out.push(String(name));
    }
  }
  return out.sort();
}

module.exports = {
  OVERFLOW_ROUTE,
  DAY_MS,
  resolveConfig,
  isSlow,
  shouldSample,
  dayKey,
  buildRouteKey,
  selectRouteKey,
  buildRecord,
  emptyRouteRecord,
  mergeSummary,
  percentileNearestRank,
  summarizeRoute,
  shouldAlert,
  formatDuration,
  formatAlert,
  shardFileName,
  parseShardDay,
  expiredShards,
};
