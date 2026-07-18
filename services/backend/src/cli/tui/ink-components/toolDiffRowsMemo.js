'use strict';

// toolDiffRowsMemo.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 StreamingBlock 每帧对**已完成工具**的 diff 行重复构造。
//
// 背景(诊断):流式渲染时父 App 每帧(~25fps)重渲染,ToolLines(plain function,未 React.memo)
// 对时间线里**每个已完成工具**都重跑 diff 行构造:
//   ① 写入/编辑(Write/Edit/MultiEdit,_khyWriteDiff)→ buildWriteDiffRows → computeStructuredDiffHunks
//      (对 before/after 全文做**结构化 diff**,昂贵);
//   ② shell/命令 stdout 形似 unified diff → buildShellDiffRows → splitDiffLines 全量切行 + 逐行正则分类。
// 但已完成工具的 result(及其 _khyWriteDiff)是**冻结快照**(内容不再变),每帧重算是纯浪费——
// 一个大 diff 的工具在其后每一帧都重跑整份 diff,随后续工具运行时长累积成可感卡顿。
//
// 关键:diff **行数据**只依赖输入内容,**不依赖终端列宽**(buildWriteDiffRows/buildShellDiffRows 只读
// process.env 门控,列宽在 renderDiffRows 的 clip 阶段才施加)。故按输入**对象身份**记忆行数据、每帧仍
// 用当帧列宽重渲 → 终端 resize 行为不变,且输出**逐字节等价**。
//
// 修复:按 keyObj(写入=_khyWriteDiff 对象;shell=result 对象——二者对已完成工具皆为稳定引用)的
// **WeakMap** 记忆行数据,内层按 expanded(true/false)分档。WeakMap:无需逐出、随工具对象 GC 自动回收;
// 且 identity 语义天然安全——运行中工具若每帧换新 result 对象则 miss→重算(不会取到陈旧)。computeFn 由
// 调用方注入(叶子不依赖 ToolLines 内部),命中返回**同一行数组引用**(下游 renderDiffRows/planWordDiffPairs
// 已核实只读、不改 rows)。门控 KHY_TOOL_DIFF_ROWS_MEMO 默认开;关 → 直接 computeFn()(逐字节回退今日)。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TOOL_DIFF_ROWS_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

const _cache = new WeakMap(); // keyObj -> Map<expandedKey(0|1), rows>

/**
 * 按 keyObj 对象身份 + expanded 档记忆 diff 行数据。绝不抛(异常 → 尽力 computeFn(),再异常 → null)。
 * 命中返回缓存值(含 null——「无可渲染 diff」也是确定性结果,值得缓存);缺失/门控关 → computeFn()。
 *
 * @param {object} keyObj - 稳定对象键(写入=_khyWriteDiff;shell=result)。非对象/假值 → 不缓存直算。
 * @param {boolean} expanded
 * @param {Function} computeFn - () => rows|null,昂贵的原构造闭包
 * @param {object} [env]
 * @returns {Array|null}
 */
function memoDiffRows(keyObj, expanded, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !keyObj || typeof keyObj !== 'object') return computeFn();
    const k = expanded ? 1 : 0;
    let byExpanded = _cache.get(keyObj);
    if (byExpanded && byExpanded.has(k)) return byExpanded.get(k);
    const rows = computeFn();
    if (!byExpanded) { byExpanded = new Map(); _cache.set(keyObj, byExpanded); }
    byExpanded.set(k, rows);
    return rows;
  } catch {
    try { return computeFn(); } catch { return null; }
  }
}

module.exports = { isEnabled, memoDiffRows, OFF_VALUES };
