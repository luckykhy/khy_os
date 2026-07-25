'use strict';

/**
 * sessionColorState.js — `/color` 的进程级活动色持有者(薄壳)。
 *
 * CC `/color` 既写 transcript(持久)又即时更新 AppState(立即可见)。khy 对应物:
 *   - 持久层 = 会话元数据(由 `handlers/color.js` 写,跨会话留存)。
 *   - 即时层 = 本模块的进程级单值,Ink TUI `App.js` 每帧读它喂给 PromptFrame 的 accent。
 *
 * 首帧惰性从「当前会话元数据」播种一次(`_loaded` 守卫,避免每帧读盘);此后以
 * `setSessionColor` 的写入为准。纯逻辑(校验/优先级)在叶子 `cli/sessionColor.js`,
 * 本壳只持有可变值 + best-effort 读当前会话色。
 */

let _color = null;     // 当前活动会话色(null = 默认 cyan)
let _loaded = false;   // 是否已尝试从元数据播种

function setSessionColor(color) {
  const c = color == null ? null : String(color).trim().toLowerCase();
  // 'default' 哨兵或空 → 视为重置(null)。
  _color = c && c !== 'default' ? c : null;
  _loaded = true;
}

function _seedOnce() {
  if (_loaded) return;
  _loaded = true; // 无论成败只播种一次
  try {
    const sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
    if (!sessionId) return;
    const meta = require('../../services/sessionPersistence').loadSessionMeta(sessionId);
    const c = meta && meta.metadata && meta.metadata.color;
    if (c && String(c).toLowerCase() !== 'default') _color = String(c).toLowerCase();
  } catch { /* best-effort: no session / no metadata → stay default */ }
}

/** App.js 每帧调用:返回当前会话色(null = 默认)。首帧惰性播种。 */
function getSessionColor() {
  if (!_loaded) _seedOnce();
  return _color;
}

/** 测试钩子:重置进程级状态。 */
function _reset() { _color = null; _loaded = false; }

module.exports = { setSessionColor, getSessionColor, _reset };
