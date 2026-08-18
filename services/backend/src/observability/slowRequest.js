'use strict';

/**
 * slowRequest.js — 薄壳(副作用):慢请求告警的落地层。
 *
 * 纯逻辑全在 slowRequestCore.js;这里只做四件带副作用的事,每一件都挂在
 * **既有**载体上(F1 只扩展不重建,不新起第二套遥测框架):
 *
 *   1. 聚合  → telemetryService.trackSlowRequest()  (.khy/telemetry/slow_requests.json)
 *   2. 明细  → .khy/monitor/slow-YYYY-MM-DD.jsonl   (日分片,追加写,按保留期清理)
 *   3. 事件  → eventLog.append({type:'perf.slow_request'}) (JSONL + eventBus 实时扇出)
 *   4. 告警  → logger.warn(slowRequestCore.formatAlert())  (规则 2:动作+目标+进度)
 *
 * 命名避让:`.khy/monitor/` 是 tools/MonitorTool 的地盘(它写 `mon-<taskId>.log`)。
 * 本模块只写 `slow-*.jsonl` 与 `profiles/`,清理时也只认 `slow-*.jsonl` 前缀,
 * 绝不会误删 MonitorTool 的日志。
 *
 * 隐私(F3):全部产物只落本地 .khy/,不发起任何网络请求。
 *
 * 开销(F2):
 *   - 未开启时 record() 第一行就返回,零分配、零 IO、零定时器。
 *   - 开启后明细写盘是**缓冲 + 去抖**的(与 toolExecutionMetrics 同策略),
 *     热路径只做一次 push;定时器 unref,不阻止进程退出。
 *   - 调用点在 res.on('finish') 内,即响应已冲刷之后 —— 不进请求延迟。
 *
 * 契约:record() 永不抛异常。可观测性坏掉不能拖垮业务请求。
 */

const fs = require('fs');
const path = require('path');

const core = require('./slowRequestCore');

// 缓冲落盘参数 — 与 toolExecutionMetrics 的 FLUSH_DEBOUNCE_MS / RECORD_THRESHOLD 同量级。
const FLUSH_DEBOUNCE_MS = 3000;
const FLUSH_RECORD_THRESHOLD = 50;

const _state = {
  sample: { acc: 0 },
  buffer: [],
  timer: null,
  exitHooked: false,
  prunedDay: '',
  warnedOnce: false,
};

function _warnOnce(logger, message) {
  if (_state.warnedOnce) {
    return;
  }
  _state.warnedOnce = true;
  try {
    (logger && typeof logger.warn === 'function' ? logger : console).warn(
      `[slowRequest] 明细写入失败,已降级为「仅聚合 + 事件」模式:${message}`
    );
  } catch {
    /* ignore */
  }
}

/** 解析(并创建)`.khy/monitor/` 目录。失败返回 null(降级,不抛)。 */
function getMonitorDir() {
  try {
    const { getDataDir } = require('../utils/dataHome');
    return getDataDir('monitor');
  } catch {
    return null;
  }
}

/** 今日明细分片的绝对路径。 */
function shardPath(day) {
  const dir = getMonitorDir();
  return dir ? path.join(dir, core.shardFileName(day)) : null;
}

/**
 * 清理超出保留期的 slow-*.jsonl 分片。每个进程每天最多跑一次。
 * 只删严格匹配 `slow-YYYY-MM-DD.jsonl` 的文件 —— mon-*.log 与 profiles/ 不受影响。
 */
function pruneShards(todayKey, retentionDays) {
  if (_state.prunedDay === todayKey) {
    return [];
  }
  _state.prunedDay = todayKey;
  const dir = getMonitorDir();
  if (!dir) {
    return [];
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const expired = core.expiredShards(names, todayKey, retentionDays);
  const removed = [];
  for (const name of expired) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

function _scheduleFlush() {
  if (_state.timer) {
    return;
  }
  _state.timer = setTimeout(() => {
    _state.timer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
  // Never hold the process open for a telemetry flush.
  if (typeof _state.timer.unref === 'function') {
    _state.timer.unref();
  }
  if (!_state.exitHooked) {
    _state.exitHooked = true;
    try {
      process.once('exit', () => flush());
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把缓冲区里的明细写进当日分片(按 day 分组,一次 append 一组)。
 * 同步写,但只在去抖到期/进程退出时发生,不在请求路径上。永不抛。
 *
 * @returns {number} 实际写出的行数
 */
function flush() {
  if (_state.buffer.length === 0) {
    return 0;
  }
  const pending = _state.buffer.splice(0, _state.buffer.length);
  const byDay = new Map();
  for (const rec of pending) {
    const day = String(rec.day || '');
    if (!byDay.has(day)) {
      byDay.set(day, []);
    }
    byDay.get(day).push(JSON.stringify(rec));
  }

  let written = 0;
  for (const [day, lines] of byDay) {
    const file = shardPath(day);
    if (!file) {
      continue;
    }
    try {
      fs.appendFileSync(file, lines.join('\n') + '\n');
      written += lines.length;
    } catch (err) {
      _warnOnce(null, err && err.message ? err.message : String(err));
    }
  }
  return written;
}

/**
 * 记录一次慢请求。**永不抛异常。**
 *
 * 调用方(observability/metrics.js 的 res.on('finish'))只负责判定 duration
 * 是否越阈值;采样、聚合、写盘、发事件、告警都在这里。
 *
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.path        已由 metrics.normalizePath 归一化的路径
 * @param {number} p.durationMs
 * @param {number|string} [p.statusCode]
 * @param {string} [p.requestId]
 * @param {string} [p.traceId]
 * @param {object} [p.logger]    winston logger;缺省退回 console
 * @param {object} [p.config]    预解析配置(调用方缓存以省一次 env 解析)
 * @param {number} [p.now]       注入时钟(测试用)
 * @returns {{recorded:boolean,alerted:boolean,summary:object}|null}
 */
function record(p = {}) {
  try {
    const cfg = p.config || core.resolveConfig();
    if (!cfg.enabled) {
      return null;
    }
    if (!core.isSlow(p.durationMs, cfg.thresholdMs)) {
      return null;
    }
    if (!core.shouldSample(cfg.sampleRate, _state.sample)) {
      return null;
    }

    const now = Number.isFinite(Number(p.now)) ? Number(p.now) : Date.now();
    const telemetry = require('../services/telemetryService');

    // 1. 聚合(先做:todayCount 要从聚合结果里取,告警文案依赖它)。
    const staged = core.buildRecord({
      now,
      method: p.method,
      path: p.path,
      durationMs: p.durationMs,
      thresholdMs: cfg.thresholdMs,
      statusCode: p.statusCode,
      requestId: p.requestId,
      traceId: p.traceId,
      todayCount: 0,
    });
    const summary = telemetry.trackSlowRequest(staged, {
      maxRoutes: cfg.maxRoutes,
      maxSamples: cfg.maxSamples,
    });
    const entry = { ...staged, route: summary.route, todayCount: summary.todayCount };

    // 2. 明细 → .khy/monitor/slow-<day>.jsonl(缓冲 + 去抖)。
    _state.buffer.push(entry);
    if (_state.buffer.length >= FLUSH_RECORD_THRESHOLD) {
      flush();
    } else {
      _scheduleFlush();
    }
    pruneShards(entry.day, cfg.retentionDays);

    // 3. 事件 → eventLog(JSONL 持久化 + eventBus 实时扇出)。
    try {
      require('./eventLog').append({
        type: 'perf.slow_request',
        source: 'observability/slowRequest',
        traceId: entry.traceId || undefined,
        payload: {
          method: entry.method,
          path: entry.path,
          route: entry.route,
          durationMs: entry.durationMs,
          thresholdMs: entry.thresholdMs,
          statusCode: entry.statusCode,
          requestId: entry.requestId,
          todayCount: entry.todayCount,
          p95Ms: summary.p95,
        },
      });
    } catch {
      /* event log unavailable — aggregation already landed */
    }

    // 4. 告警(按路由去抖:慢请求成批出现,逐条刷屏会淹掉信号)。
    let alerted = false;
    const lastAlertAt = telemetry.getSlowRequestLastAlertAt(summary.route);
    if (core.shouldAlert(lastAlertAt, now, cfg.cooldownMs)) {
      alerted = true;
      telemetry.markSlowRequestAlerted(summary.route, now);
      const logger = p.logger && typeof p.logger.warn === 'function' ? p.logger : console;
      try {
        logger.warn(core.formatAlert(entry), {
          route: entry.route,
          durationMs: entry.durationMs,
          thresholdMs: entry.thresholdMs,
          todayCount: entry.todayCount,
          p95Ms: summary.p95,
          requestId: entry.requestId,
        });
      } catch {
        /* logger failure must not break the request */
      }
    }

    return { recorded: true, alerted, summary };
  } catch {
    // 可观测性坏掉不能拖垮业务请求。
    return null;
  }
}

/** 测试钩子:清空内存态(缓冲、采样累加器、清理标记)。 */
function _resetForTest() {
  if (_state.timer) {
    clearTimeout(_state.timer);
    _state.timer = null;
  }
  _state.sample = { acc: 0 };
  _state.buffer.length = 0;
  _state.prunedDay = '';
  _state.warnedOnce = false;
}

module.exports = {
  record,
  flush,
  pruneShards,
  getMonitorDir,
  shardPath,
  FLUSH_DEBOUNCE_MS,
  FLUSH_RECORD_THRESHOLD,
  _resetForTest,
  _state,
};
