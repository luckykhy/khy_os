'use strict';

/**
 * perfEntryReaper — 周期性清理 React development 渲染累积的 performance.measure 条目。
 *
 * 根因(「TUI 越用越卡 / 长时间运行后搜索卡死」的隐性放大器):khy TUI 用 React development 版
 * (NODE_ENV 未设 → react-reconciler.development.js),其中 `supportsUserTiming` 在 console.timeStamp
 * 存在时恒为 true,渲染追踪回调(logComponentEffect/logRecoveredRenderPhase 等)每帧调
 * `performance.measure(...)` **且从不 `clearMeasures`**。Node 的全局 performance entry buffer 有
 * 上限,超限即抛 `MaxPerformanceEntryBufferExceededWarning`(截图实证:1000001 measure entries),
 * 同时每条 entry 持续占内存,25fps × 数小时 = 数百万条 → 内存/性能持续劣化 → 每帧渲染越来越慢,
 * 表现为「搜索转圈几小时 / 界面卡死」。
 *
 * 修:在 TUI 启动时安装一个低频率(默认 60s)定时器,周期 `performance.clearMeasures()` +
 * `performance.clearMarks()`(两者都只是清全局 buffer,零副作用、不影响任何业务计时——khy 源码
 * 从不主动使用 perf_hooks)。门控 KHY_PERF_ENTRY_REAP 默认 on;关 → 不安装(逐字节回退今日行为)。
 *
 * 契约:零 IO、绝不抛、定时器 unref(不阻止进程退出)、幂等(可重复安装/销毁)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _enabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  const raw = String(
    e.KHY_PERF_ENTRY_REAP === undefined || e.KHY_PERF_ENTRY_REAP === null
      ? ''
      : e.KHY_PERF_ENTRY_REAP
  )
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(raw);
}

function _intervalMs(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  const raw = Number.parseInt(String(e.KHY_PERF_ENTRY_REAP_MS || ''), 10);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(600000, Math.max(5000, raw));
  }
  return 60000;
}

/**
 * 清理一次全局 performance entries(buffer 里的 measure + mark)。绝不抛。
 */
function reapOnce() {
  try {
    const perf =
      typeof performance !== 'undefined' ? performance : require('perf_hooks').performance;
    if (perf && typeof perf.clearMeasures === 'function') {
      perf.clearMeasures();
    }
    if (perf && typeof perf.clearMarks === 'function') {
      perf.clearMarks();
    }
  } catch {
    /* 清理失败绝不影响 TUI */
  }
}

let _timer = null;
let _installed = false;

/**
 * 安装周期性清理。幂等:重复调用不叠加定时器。
 * @param {object} [opts] { env, perf } — 测试可注入。
 * @returns {{ stop: () => void, installed: boolean }}
 */
function installPerfReaper(opts = {}) {
  const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
  if (!_enabled(env)) {
    return { stop: () => {}, installed: false };
  }
  if (_installed) {
    return { stop: stopPerfReaper, installed: true };
  }

  const ms = _intervalMs(env);
  try {
    _timer = setInterval(() => reapOnce(opts), ms);
    if (_timer && typeof _timer.unref === 'function') {
      _timer.unref();
    }
    _installed = true;
  } catch {
    _timer = null;
    _installed = false;
  }
  return { stop: stopPerfReaper, installed: _installed };
}

/** 停止并销毁定时器(幂等)。 */
function stopPerfReaper() {
  if (_timer) {
    try {
      clearInterval(_timer);
    } catch {
      /* ignore */
    }
    _timer = null;
  }
  _installed = false;
}

module.exports = {
  isEnabled: _enabled,
  intervalMs: _intervalMs,
  reapOnce,
  installPerfReaper,
  stopPerfReaper,
  OFF_VALUES,
};
