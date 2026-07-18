'use strict';

/**
 * inputCursorMetricsMemo — 经典 REPL 主输入光标度量的单槽记忆(纯叶子)。
 *
 * 承 keystroke 流畅性同族(渲染热路径每键 O(n) 全量重算)。
 *
 * 根因:`repl.js::_getInputCursorMetrics()` 在 `rl._refreshLine`(**每按键**触发)里被调,单次刷新内
 * 还被 `_inputVisualRows` / bottom-decoration repaint 等多处再调。每次它:
 *   ① `rl._prompt.replace(/\x1b\[[^m]*m/g,'')` —— 对 prompt 串做 ANSI 剥离正则(prompt 在两次
 *      prompt 周期间**静态**,却每键重算);
 *   ② `displayWidth(rl.line)` + `displayWidth(line.slice(0,cursor))` —— 两次显示宽度测量。前者经
 *      [[project_display_width_memo_keystroke]] 已按整行 memo;但 `inputBeforeCursor` 每键随光标推进
 *      **变成新前缀串**,几乎永不命中整行 memo → 每键仍 O(n) 全量测量,且随行增长。
 * 净效:同一按键内 metrics 被重算多次,且 promptLen 正则每键重跑。
 *
 * 修:`_getInputCursorMetrics` 的输出是 `(line, cursor, cols, promptRaw)` 四元组的**纯函数**。
 *   - 单槽记忆整份 metrics:同一元组(同一按键内多处调用、或未变更时的重复刷新)直接返缓存对象。
 *   - promptLen 另按 prompt 串单槽缓存 ANSI-剥离长度(prompt 不变则跳正则)。
 * 计算逻辑不搬进叶子——由注入的 `computeFn` 承担;叶子只在其外包一层「元组未变即复用」。
 *
 * 纯叶子纪律:零 IO、确定性(缓存进程内)、绝不抛;门控关 / 异常 → `computeFn()`(逐字节回退)。
 * 单槽(非 LRU):键入是顺序的,相邻按键元组必变,单槽命中的正是「同一按键内的重复调用」+「无变更重刷」。
 *
 * 门控 `KHY_INPUT_CURSOR_METRICS_MEMO` 默认开;关 → 每次现算,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_INPUT_CURSOR_METRICS_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// ── promptLen 缓存(按 prompt 原串)──────────────────────────────────────────
// prompt 在两次 prompt 周期间静态;ANSI 剥离正则每键重跑纯属浪费。
const _ANSI_RE = /\x1b\[[^m]*m/g;
let _promptRawCached = null;
let _promptLenCached = 0;

/**
 * 取 prompt 的可见长度(剥 ANSI),按 prompt 原串单槽缓存。
 * @param {string} promptRaw
 * @returns {number}
 */
function getPromptLen(promptRaw) {
  const raw = typeof promptRaw === 'string' ? promptRaw : String(promptRaw == null ? '' : promptRaw);
  if (raw === _promptRawCached) return _promptLenCached;
  const len = raw.replace(_ANSI_RE, '').length;
  _promptRawCached = raw;
  _promptLenCached = len;
  return len;
}

// ── metrics 单槽记忆 ────────────────────────────────────────────────────────
let _slot = null; // { line, cursor, cols, promptRaw, metrics }

/**
 * 取(或首算)主输入光标度量,按 (line,cursor,cols,promptRaw) 单槽记忆。
 * @param {object} key { line, cursor, cols, promptRaw }
 * @param {() => object} computeFn 现算 metrics 的函数
 * @returns {object} metrics
 */
function getMetrics(key, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !key || typeof computeFn !== 'function') {
      return computeFn();
    }
    const { line, cursor, cols, promptRaw } = key;
    if (
      _slot &&
      _slot.line === line &&
      _slot.cursor === cursor &&
      _slot.cols === cols &&
      _slot.promptRaw === promptRaw &&
      _slot.metrics
    ) {
      return _slot.metrics;
    }
    const metrics = computeFn();
    // 仅缓存对象形态的结果(防把异常态/非对象污染槽)。
    if (metrics && typeof metrics === 'object') {
      _slot = { line, cursor, cols, promptRaw, metrics };
    }
    return metrics;
  } catch {
    try { return computeFn(); } catch { return null; }
  }
}

// 测试/生命周期钩子。
function _clear() {
  _slot = null;
  _promptRawCached = null;
  _promptLenCached = 0;
}
function _hasSlot() { return _slot != null; }

module.exports = {
  isEnabled,
  getPromptLen,
  getMetrics,
  _clear,
  _hasSlot,
  OFF_VALUES,
};
