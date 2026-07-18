'use strict';

// toolLiteralOutputMemo.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 StreamingBlock 每帧对**已完成工具**的 LITERAL(非 diff)输出体重复构造——
// 与姊妹叶子 toolDiffRowsMemo(只覆盖 diff 形输出)互补,合起来把 renderLiteralOutput
// 的两处每帧 O(输出长度) 计算全部收敛。
//
// 背景(诊断,承 [[toolDiffRowsMemo]] 同族):流式渲染时父 App 每帧(~25fps)重渲染,
// ToolLines(plain function,未 React.memo)对 live 尾窗里**每个已完成工具**重跑
// renderLiteralOutput。其中两处纯 O(输出) 计算**每帧无谓重算**:
//   ① 行 437 `formatShellOutputJson(resultPreview(result))` —— 对**整份** stdout 尝试
//      JSON parse+pretty-print,**无条件每帧**跑(diff 分支也先算 preview 再判形),大输出
//      即每帧 O(输出);
//   ② 行 449-461 字面折叠管线:`split('\n')` 全量切行 + 去尾空行 + collapseConsecutiveDuplicates
//      + foldOutput —— 非 diff 命令/三方 stdout 每帧全量重折。
// 但已完成工具的 result 是**冻结快照**(内容不再变),这些都是 `(result, expanded)` 的确定性
// 纯函数,每帧重算是纯浪费——一个大输出的工具在其后每一帧都重跑整份格式化+折叠,随后续
// 工具运行时长累积成可感卡顿。
//
// 关键(与 toolDiffRowsMemo 一致的正确性论证):
//   • preview(formatShellOutputJson 结果)只依赖 resultPreview(result) + env 门控,**不依赖
//     expanded、不依赖终端列宽** → 按 result 对象身份单键记忆。
//   • shownLines(折叠后行数组)依赖 (result, expanded),**不依赖列宽**(列宽只在下游 truncate(
//     ln, litClipW) 阶段每帧现场施加,留在 memo 外)→ 按 result 身份 + expanded 档记忆。
//   • 命中返回**同一** preview 字符串 / shownLines 数组引用;下游只读(split 已在 memo 内做完;
//     truncate 不改数组、只读逐行)→ 终端 resize 行为不变,输出**逐字节等价**。
//
// WeakMap 键:result 对象(已完成工具皆为稳定引用——toolDiffRowsMemo 已在生产用 result 作键
// 验证此不变量)。无需逐出、随工具对象 GC 自动回收;运行中工具若每帧换新 result 对象则 miss→
// 重算(不取陈旧)。env 变化不使缓存失效——与 toolDiffRowsMemo 同一取舍(env 单会话内稳定)。
//
// 门控 KHY_TOOL_LITERAL_OUTPUT_MEMO 默认开;关/异常 → 直接 computeFn()(逐字节回退今日)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TOOL_LITERAL_OUTPUT_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// preview 缓存:result -> preview 字符串(expanded 无关)。
const _previewCache = new WeakMap();
// 折叠行缓存:result -> Map<expandedKey(0|1), shownLines>。
const _linesCache = new WeakMap();

/**
 * 记忆 formatShellOutputJson(resultPreview(result)) 的结果(preview 字符串)。
 * 按 result 对象身份记忆(不含 expanded 档——preview 与 expanded 无关)。
 * 绝不抛(异常 → 尽力 computeFn(),再异常 → '')。
 *
 * @param {object} result - 稳定对象键(已完成工具的 result)。非对象/假值 → 不缓存直算。
 * @param {Function} computeFn - () => string,原 formatShellOutputJson 闭包
 * @param {object} [env]
 * @returns {string}
 */
function memoPreview(result, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !result || typeof result !== 'object') return computeFn();
    if (_previewCache.has(result)) return _previewCache.get(result);
    const preview = computeFn();
    _previewCache.set(result, preview);
    return preview;
  } catch {
    try { return computeFn(); } catch { return ''; }
  }
}

/**
 * 记忆折叠后的行数组 shownLines。按 result 身份 + expanded 档记忆(与 toolDiffRowsMemo 同构)。
 * 命中返回缓存数组(下游只读逐行 truncate,不改数组);缺失/门控关 → computeFn()。
 * 绝不抛(异常 → 尽力 computeFn(),再异常 → [])。
 *
 * @param {object} result - 稳定对象键。非对象/假值 → 不缓存直算。
 * @param {boolean} expanded
 * @param {Function} computeFn - () => string[],原 split+collapse+fold 闭包
 * @param {object} [env]
 * @returns {string[]}
 */
function memoFoldedLines(result, expanded, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !result || typeof result !== 'object') return computeFn();
    const k = expanded ? 1 : 0;
    let byExpanded = _linesCache.get(result);
    if (byExpanded && byExpanded.has(k)) return byExpanded.get(k);
    const lines = computeFn();
    if (!byExpanded) { byExpanded = new Map(); _linesCache.set(result, byExpanded); }
    byExpanded.set(k, lines);
    return lines;
  } catch {
    try { return computeFn(); } catch { return []; }
  }
}

module.exports = { isEnabled, memoPreview, memoFoldedLines, OFF_VALUES };
