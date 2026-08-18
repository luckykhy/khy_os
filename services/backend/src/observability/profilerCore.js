'use strict';

/**
 * profilerCore.js — 纯叶子(zero-IO, 确定性):CPU profiling 与事件循环延迟
 * 监测背后的全部纯逻辑。
 *
 * 与 cli/heapDump.js 互补:heapDump 管**内存**侧(V8 堆快照 + 原生内存诊断),
 * 本模块管 **CPU** 侧 ——
 *   A. 按需采样:node:inspector 的 Profiler.start/stop 产出 .cpuprofile
 *      (Chrome DevTools / VS Code / speedscope 可直接打开)。
 *   B. 连续监测:perf_hooks.monitorEventLoopDelay() 的直方图,直方图本身
 *      在 C++ 侧维护,JS 侧只在读取时才有开销。
 *
 * 这里只放确定性逻辑:配置解析、profile id 生成、元数据组装、直方图摘要、
 * 越阈值判定、结果/错误措辞。真正 require('node:inspector') / 起
 * monitorEventLoopDelay / 写文件都是副作用,留在薄壳
 * (cpuProfiler.js / eventLoopMonitor.js)。
 *
 * 默认关闭(F2 零开销):OBSERVABILITY.PROFILING_ENABLED 默认 false。
 */

const { OBSERVABILITY } = require('../constants/serviceDefaults');

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
 * 解析生效配置:serviceDefaults 默认值 + env 覆盖(纯函数,env 注入)。
 *
 * @param {object} [env=process.env]
 * @returns {{enabled:boolean,durationMs:number,maxDurationMs:number,sampleIntervalUs:number,
 *            resolutionMs:number,checkIntervalMs:number,lagThresholdMs:number}}
 */
function resolveConfig(env = process.env) {
  const e = env || {};
  const maxDurationMs = Math.max(
    1000,
    _int(e.KHY_PROFILING_MAX_DURATION_MS, OBSERVABILITY.PROFILING_MAX_DURATION_MS)
  );
  const durationMs = Math.max(
    100,
    Math.min(maxDurationMs, _int(e.KHY_PROFILING_DURATION_MS, OBSERVABILITY.PROFILING_DURATION_MS))
  );
  return {
    enabled: _bool(e.KHY_PROFILING_ENABLED, OBSERVABILITY.PROFILING_ENABLED),
    durationMs,
    maxDurationMs,
    sampleIntervalUs: Math.max(
      1,
      _int(e.KHY_PROFILING_SAMPLE_INTERVAL_US, OBSERVABILITY.PROFILING_SAMPLE_INTERVAL_US)
    ),
    resolutionMs: Math.max(
      1,
      _int(e.KHY_EVENTLOOP_RESOLUTION_MS, OBSERVABILITY.EVENTLOOP_RESOLUTION_MS)
    ),
    checkIntervalMs: Math.max(
      1000,
      _int(e.KHY_EVENTLOOP_CHECK_INTERVAL_MS, OBSERVABILITY.EVENTLOOP_CHECK_INTERVAL_MS)
    ),
    lagThresholdMs: Math.max(
      1,
      _int(e.KHY_EVENTLOOP_LAG_THRESHOLD_MS, OBSERVABILITY.EVENTLOOP_LAG_THRESHOLD_MS)
    ),
  };
}

/**
 * 把请求的采样时长夹到 [100ms, maxDurationMs];非法输入退回默认时长。
 * 「基于活动的超时」不适用于此:这是一个用户主动指定的**固定采样窗口**,
 * 不是在杀一个进行中的任务 —— 采样自然结束,不 kill 任何东西。
 */
function clampDuration(requestedMs, cfg) {
  const c = cfg || resolveConfig();
  const n = Number(requestedMs);
  if (!Number.isFinite(n) || n <= 0) {
    return c.durationMs;
  }
  return Math.max(100, Math.min(c.maxDurationMs, Math.round(n)));
}

/** 文件名安全的时间戳片段(与 heapDump._timestampSlug 同规则,Windows 安全)。 */
function timestampSlug(now) {
  const n = Number(now);
  return new Date(Number.isFinite(n) && n >= 0 ? n : 0).toISOString().replace(/[:.]/g, '-');
}

/**
 * profile 基名(不含扩展名)。刻意用 `cpu-` 前缀 —— `.khy/monitor/` 下
 * MonitorTool 已占用 `mon-*` 前缀,两者不得冲突。
 */
function buildProfileId(now) {
  return `cpu-${timestampSlug(now)}`;
}

function _num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 组装 profile 元数据 JSON(与 .cpuprofile 并排落盘)。
 * .cpuprofile 只含调用树,进程侧上下文(内存/uptime/触发源)不在里面。
 */
function buildProfileMeta(p = {}) {
  const mem = p.memoryUsage || {};
  const now = _num(p.now);
  return {
    profileId: String(p.profileId || ''),
    timestamp: new Date(now).toISOString(),
    trigger: String(p.trigger || 'manual'),
    requestedDurationMs: _num(p.requestedDurationMs),
    elapsedMs: _num(p.elapsedMs),
    sampleIntervalUs: _num(p.sampleIntervalUs),
    sampleCount: _num(p.sampleCount),
    nodeCount: _num(p.nodeCount),
    pid: _num(p.pid),
    nodeVersion: String(p.nodeVersion || ''),
    uptimeSeconds: _num(p.uptimeSeconds),
    memoryUsage: {
      heapUsed: _num(mem.heapUsed),
      heapTotal: _num(mem.heapTotal),
      external: _num(mem.external),
      rss: _num(mem.rss),
    },
    cpuUsage: {
      userUs: _num(p.cpuUsage && p.cpuUsage.user),
      systemUs: _num(p.cpuUsage && p.cpuUsage.system),
    },
  };
}

/**
 * 从 inspector 返回的 profile 对象里数出节点数/样本数(不改动 profile 本体)。
 */
function summarizeProfile(profile) {
  const nodes = profile && Array.isArray(profile.nodes) ? profile.nodes : [];
  const samples = profile && Array.isArray(profile.samples) ? profile.samples : [];
  return { nodeCount: nodes.length, sampleCount: samples.length };
}

/**
 * monitorEventLoopDelay 直方图 → 毫秒摘要。直方图读数单位是**纳秒**。
 * @param {{min:number,max:number,mean:number,stddev:number,percentile:Function}} hist
 */
function summarizeLag(hist) {
  if (!hist || typeof hist.percentile !== 'function') {
    return { minMs: 0, maxMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  }
  const toMs = (ns) => {
    const n = Number(ns);
    return Number.isFinite(n) && n > 0 ? Math.round((n / 1e6) * 100) / 100 : 0;
  };
  return {
    minMs: toMs(hist.min),
    maxMs: toMs(hist.max),
    meanMs: toMs(hist.mean),
    p50Ms: toMs(hist.percentile(50)),
    p95Ms: toMs(hist.percentile(95)),
    p99Ms: toMs(hist.percentile(99)),
  };
}

/** 事件循环延迟越阈值判定(用 p99 —— 均值会把偶发的长阻塞抹平)。 */
function isLagOverThreshold(summary, thresholdMs) {
  const p99 = Number(summary && summary.p99Ms);
  const t = Number(thresholdMs);
  if (!Number.isFinite(p99) || !Number.isFinite(t)) {
    return false;
  }
  return p99 >= t;
}

/**
 * 事件循环阻塞告警文案 —— 遵守规则 2「动作 + 目标 + 进度」。
 * 例:事件循环阻塞 khy-os-backend p99 延迟 340ms,超阈值 200ms,采样窗口 30s
 */
function formatLagAlert(summary = {}, thresholdMs = 0, windowMs = 0) {
  const p99 = _num(summary.p99Ms);
  const p50 = _num(summary.p50Ms);
  const win = Math.round(_num(windowMs) / 1000);
  return (
    `事件循环阻塞 p99 延迟 ${p99}ms(p50 ${p50}ms),` +
    `超阈值 ${Math.round(_num(thresholdMs))}ms,采样窗口 ${win}s`
  );
}

function _mb(bytes) {
  return (_num(bytes) / (1024 * 1024)).toFixed(1);
}

/**
 * 成功措辞:.cpuprofile 路径 + 元数据路径 + 采样摘要 + 打开方式提示。
 * 与 heapDump.formatResult 保持同一版式。
 */
function formatResult(r = {}) {
  const profilePath = String(r.profilePath || '');
  const metaPath = String(r.metaPath || '');
  const meta = r.meta || {};
  const lines = [
    '已生成 CPU profile:',
    '  采样(.cpuprofile):' + profilePath,
    '  元数据(.json)    :' + metaPath,
    '  摘要:采样 ' +
      _num(meta.sampleCount) +
      ' 个 · 调用节点 ' +
      _num(meta.nodeCount) +
      ' 个 · 实采 ' +
      (_num(meta.elapsedMs) / 1000).toFixed(1) +
      's @ ' +
      _num(meta.sampleIntervalUs) +
      'μs · heapUsed ' +
      _mb(meta.memoryUsage && meta.memoryUsage.heapUsed) +
      ' MB',
    '提示:在 Chrome DevTools → Performance → Load profile,或 VS Code / speedscope 里',
    '      打开 .cpuprofile 查看火焰图;文件仅存本地,不会外传。',
  ];
  return lines.join('\n');
}

function formatError(message) {
  return '生成 CPU profile 失败:' + String(message == null ? 'unknown error' : message);
}

/** profiling 未开启时的引导措辞(告诉用户开关在哪,而不是干巴巴一句「未启用」)。 */
function formatDisabled() {
  return (
    'CPU profiling 未启用(默认关闭以保证零开销)。\n' +
    '  开启:设置 KHY_PROFILING_ENABLED=1 后重启后端;\n' +
    '  阈值与采样率的默认值见 constants/serviceDefaults.js 的 OBSERVABILITY 块。'
  );
}

module.exports = {
  resolveConfig,
  clampDuration,
  timestampSlug,
  buildProfileId,
  buildProfileMeta,
  summarizeProfile,
  summarizeLag,
  isLagOverThreshold,
  formatLagAlert,
  formatDuration: (ms) => `${(_num(ms) / 1000).toFixed(1)}s`,
  formatResult,
  formatError,
  formatDisabled,
};
