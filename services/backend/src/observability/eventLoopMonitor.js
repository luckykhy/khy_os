'use strict';

/**
 * eventLoopMonitor.js — 薄壳(副作用):事件循环延迟的连续监测(profiling 方案 B)。
 *
 * 用 perf_hooks.monitorEventLoopDelay():直方图在 **C++ 侧**维护,JS 侧只在
 * 读取(percentile/mean)时才有开销,所以「连续开着」的稳态成本极低 —— 这正是
 * 它能常驻、而 .cpuprofile 采样只能按需开的原因。
 *
 * 回答的是 .cpuprofile 回答不了的问题:「后端现在是不是被某个同步操作卡住了」。
 * 慢请求告警说「这个路由慢」,事件循环延迟说「整个进程卡住了,所有路由都会慢」。
 *
 * 纯逻辑(配置解析、直方图 → 毫秒摘要、越阈值判定、告警措辞)在 profilerCore.js。
 *
 * 默认关闭(F2):KHY_PROFILING_ENABLED 未开时 start() 直接返回 false,
 * 不创建直方图、不起定时器。开启后:
 *   - 直方图按 resolutionMs(默认 20ms)采样,C++ 侧维护;
 *   - 每 checkIntervalMs(默认 30s)读一次并 reset,越阈值发 perf.eventloop_lag 事件;
 *   - 定时器 unref,不阻止进程退出。
 *
 * 契约:所有导出函数永不抛异常。
 */

const core = require('./profilerCore');

const _state = {
  histogram: null,
  timer: null,
  running: false,
  config: null,
  lastSummary: null,
  windowStartedAt: 0,
  alertCount: 0,
};

/**
 * 启动连续监测。已在运行 / 未启用 / 平台不支持 → 返回 false(不抛)。
 *
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {object} [opts.env]
 * @returns {boolean} 是否真的启动了
 */
function start(opts = {}) {
  try {
    if (_state.running) {
      return false;
    }
    const cfg = core.resolveConfig(opts.env || process.env);
    if (!cfg.enabled) {
      return false;
    }

    const { monitorEventLoopDelay } = require('perf_hooks');
    if (typeof monitorEventLoopDelay !== 'function') {
      return false;
    }

    const hist = monitorEventLoopDelay({ resolution: cfg.resolutionMs });
    hist.enable();

    _state.histogram = hist;
    _state.config = cfg;
    _state.running = true;
    _state.windowStartedAt = Date.now();
    _state.alertCount = 0;

    _state.timer = setInterval(() => _checkWindow(opts.logger), cfg.checkIntervalMs);
    if (typeof _state.timer.unref === 'function') {
      _state.timer.unref();
    }

    const logger = opts.logger && typeof opts.logger.info === 'function' ? opts.logger : null;
    if (logger) {
      logger.info(
        `事件循环延迟监测已启动 分辨率 ${cfg.resolutionMs}ms,` +
          `每 ${Math.round(cfg.checkIntervalMs / 1000)}s 读取一次,告警阈值 p99 ${cfg.lagThresholdMs}ms`
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** 停止监测并释放直方图。幂等,永不抛。 */
function stop() {
  try {
    if (_state.timer) {
      clearInterval(_state.timer);
      _state.timer = null;
    }
    if (_state.histogram && typeof _state.histogram.disable === 'function') {
      _state.histogram.disable();
    }
  } catch {
    /* ignore */
  }
  _state.histogram = null;
  _state.running = false;
  return true;
}

/**
 * 读取当前窗口摘要(毫秒)。未运行时返回 null。
 * 不 reset —— 供 /metrics 抓取与 CLI 查询使用。
 */
function snapshot() {
  try {
    if (!_state.running || !_state.histogram) {
      return null;
    }
    return core.summarizeLag(_state.histogram);
  } catch {
    return null;
  }
}

/** 最近一次窗口检查的摘要(即使当下已 stop 也保留)。 */
function lastSummary() {
  return _state.lastSummary;
}

function isRunning() {
  return _state.running === true;
}

/**
 * 一个检查窗口到期:读摘要 → 越阈值则告警 + 发事件 → reset 直方图开启下一窗口。
 * 内部函数,导出仅供测试注入时钟/直方图。
 */
function _checkWindow(logger) {
  try {
    if (!_state.running || !_state.histogram) {
      return null;
    }
    const cfg = _state.config || core.resolveConfig();
    const summary = core.summarizeLag(_state.histogram);
    const now = Date.now();
    const windowMs = Math.max(0, now - _state.windowStartedAt);
    _state.lastSummary = { ...summary, windowMs, at: new Date(now).toISOString() };

    if (core.isLagOverThreshold(summary, cfg.lagThresholdMs)) {
      _state.alertCount += 1;
      const text = core.formatLagAlert(summary, cfg.lagThresholdMs, windowMs);
      const log = logger && typeof logger.warn === 'function' ? logger : console;
      try {
        log.warn(`${text},今日第 ${_state.alertCount} 次`, {
          p50Ms: summary.p50Ms,
          p95Ms: summary.p95Ms,
          p99Ms: summary.p99Ms,
          maxMs: summary.maxMs,
          thresholdMs: cfg.lagThresholdMs,
          windowMs,
        });
      } catch {
        /* logger failure is not fatal */
      }
      try {
        require('./eventLog').append({
          type: 'perf.eventloop_lag',
          source: 'observability/eventLoopMonitor',
          payload: {
            ...summary,
            thresholdMs: cfg.lagThresholdMs,
            windowMs,
            alertCount: _state.alertCount,
          },
        });
      } catch {
        /* event log unavailable */
      }
    }

    // 下一窗口从零开始,否则一次历史尖峰会永久污染 max/p99。
    if (typeof _state.histogram.reset === 'function') {
      _state.histogram.reset();
    }
    _state.windowStartedAt = now;
    return _state.lastSummary;
  } catch {
    return null;
  }
}

/** 测试钩子:清空内存态。 */
function _resetForTest() {
  stop();
  _state.config = null;
  _state.lastSummary = null;
  _state.windowStartedAt = 0;
  _state.alertCount = 0;
}

module.exports = {
  start,
  stop,
  snapshot,
  lastSummary,
  isRunning,
  _checkWindow,
  _resetForTest,
  _state,
};
