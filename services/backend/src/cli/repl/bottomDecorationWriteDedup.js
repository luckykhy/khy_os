'use strict';

/**
 * bottomDecorationWriteDedup — 底部装饰 stdout.write 的单槽去重决策器(纯叶子)。
 *
 * 承 keystroke 流畅性同族(渲染热路径每键终端 IO)。
 *
 * 根因:`repl.js` 的 `rl._refreshLine` 补丁在**每按键**无条件 `process.stdout.write(
 * _buildBottomDecorationRepaint(metrics))`(外加 syncOutput begin/end 括号)。但该重绘串仅当
 * `(metrics, rule, footer)` 变化时才不同;按了不改变几何/光标列的键、或 `_refreshLine` 以相同状态
 * 重触发时,写出的串与上一帧**逐字节相同** —— 仍触发一次终端写(IO + 潜在闪烁)。
 *
 * 修:按**上次写出的重绘串**单槽去重。串与上次相同 → `shouldWrite` 返 false,跳过 stdout.write 与
 * syncOutput 括号(免终端 IO)。串不同 → 记录并返 true(照写)。
 *
 * 安全(去重必须保守):底部装饰是**相对光标定位**的;若 frame 在别处被重建/拆除(终端下方内容被清/移),
 * 即便串不变也必须重写,否则装饰会漏画。故提供 `invalidate()`,由 repl.js 在每处 frame 渲染 / 拆除
 * (`_frameRendered` 置真/置假)时调用,强制下次必写。
 *
 * 纯叶子纪律:零 IO、确定性(状态进程内)、绝不抛;门控关 / 异常 → 恒返 true(照写=今日行为,逐字节回退)。
 *
 * 门控 `KHY_BOTTOM_DECORATION_WRITE_DEDUP` 默认开;关 → 每次必写,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_BOTTOM_DECORATION_WRITE_DEDUP;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 上次写出的重绘串(null = 尚未写 / 已失效 → 下次必写)。
let _lastWritten = null;

/**
 * 是否应把本次重绘串写到终端(去重:与上次逐字节相同 → 跳过)。
 * @param {string} str 本次将写出的重绘串
 * @param {object} [env]
 * @returns {boolean} true=照写并已记录;false=与上次相同,跳过
 */
function shouldWrite(str, env = process.env) {
  try {
    if (!isEnabled(env)) return true;                 // 门控关 → 恒写(逐字节回退)
    if (typeof str !== 'string') return true;         // 非串 → 保守照写
    if (_lastWritten !== null && _lastWritten === str) return false; // 与上次相同 → 跳过
    _lastWritten = str;                               // 记录本次写出
    return true;
  } catch {
    return true;                                      // 异常 → 保守照写
  }
}

/**
 * 使去重槽失效:强制下次 shouldWrite 必返 true。
 * 在 frame 渲染 / 拆除等「终端下方状态被别处改动」时调用。
 */
function invalidate() { _lastWritten = null; }

// 测试/生命周期钩子。
function _peek() { return _lastWritten; }

module.exports = {
  isEnabled,
  shouldWrite,
  invalidate,
  _peek,
  OFF_VALUES,
};
