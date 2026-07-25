'use strict';

// promptCaretMarginMemo.js — pure leaf (single-slot memo, deterministic, never throws).
//
// 目的:消除「补全下拉(/命令·@文件)打开时,每次 App 无关重渲染都对整条输入 buffer 重算
// 补全菜单的横向对齐列(caret margin)」的浪费。
//
// 背景(承 [[project_prompt_layout_memo_input_rewrap_per_render]] 同族):App.js 渲染体在
// `completion.active && completionFollowEnabled` 时,调 `PromptFrame.layoutPromptRows({value,
// offset,cols})`(对整条 buffer 逐字符跑 string-width/CJK 宽度重排)+ `caretGeometry.caretColumn`
// + `clampColumn` 求下拉左边距 `_completionMarginLeft`。但补全菜单打开期间,用户按 ↑/↓ 在候选
// 列表里导航时,App 因 `selectedIndex` 变化而重渲染——**value/offset/cols 完全不变**,却每次
// 重跑整条 buffer 的 layout + caret 几何。buffer 里坐着长路径/多 KB 粘贴时 = 每次方向键 O(buffer)。
//
// 关键取证:`_completionMarginLeft` 是 (value, offset, cols) 的**确定性纯函数**(layoutPromptRows
// 纯、caretColumn/clampColumn 纯、displayWidth 确定)。故按这三输入单槽记忆 → 输入不变复用上次
// margin,与每帧重算**逐字节等价**。
//
// 门控 KHY_COMPLETION_MARGIN_MEMO default-on;关/异常 → 直接调 computeFn(逐字节回退)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_COMPLETION_MARGIN_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 单槽:{ value, offset, cols, margin }。补全菜单是单例、单输入框 → 单槽足够。
let _last = null;

/**
 * 记忆补全下拉左边距(caret margin)。key = (value, offset, cols) 严格相等。
 * @param {string} value - 当前输入 buffer
 * @param {number} offset - 光标 UTF-16 偏移
 * @param {number} cols - 终端列宽
 * @param {Function} computeFn - 计算 margin 的纯闭包(layoutPromptRows+caretColumn+clamp)
 * @param {object} [env]
 * @returns {number} 左边距(整数),异常兜底 0
 */
function memoCompletionMargin(value, offset, cols, computeFn, env = process.env) {
  try {
    if (!isEnabled(env)) return computeFn();
    if (_last && _last.value === value && _last.offset === offset && _last.cols === cols) {
      return _last.margin;
    }
    const margin = computeFn();
    _last = { value, offset, cols, margin };
    return margin;
  } catch {
    try { return computeFn(); } catch { return 0; }
  }
}

// 测试辅助:复位单槽。
function _reset() { _last = null; }

module.exports = { isEnabled, memoCompletionMargin, _reset, OFF_VALUES };
