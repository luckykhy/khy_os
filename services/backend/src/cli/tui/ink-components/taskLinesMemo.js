'use strict';

// taskLinesMemo.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除任务清单面板在**每次 App render**(含每次按键)对 mergeTaskLines 的重复解析。
//
// 背景(诊断,承 staticItemsMemo/toolTargetMemo 同族):App.js:2151 `_readMergedTaskLines()` 在组件体里
// 每 render 跑一遍——`taskStore.snapshot()`(构建任务清单文本)→ `mergeTaskLines(snap, planTasks)`
// (把该文本**再切回行 + 去重**)。它在每流式帧 AND **每次按键**触发。但任务状态在绝大多数 render 里
// 不变(打字、流式帧都不改任务),于是每帧「构建字符串→再解析回行」纯浪费,任务多(多 agent 编排数十行)
// 时叠进最延迟敏感的字符回显路径。
//
// 关键:`mergeTaskLines` 是 `(snapshotText, panelTasks)` 的**纯函数**(formatPanelStateLines + split/去重,
// 无 IO/无 env)。故按「snap 字符串值 + planTasks 引用」单槽记忆其输出:snap 值相等且 planTasks 同引用
// → 复用上次 lines(跳过解析);任一变 → 重算。snapshot() 的**字符串构建**仍每帧跑(键须现值),本刀只消
// **解析**这一层冗余(留 snapshot 构建给未来的 store 版本号信号)。门控 KHY_TASK_LINES_MEMO 默认开;
// 关 → 每帧直接 computeFn()(逐字节回退今日)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TASK_LINES_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 单槽缓存(TUI 仅一个 App / 一个任务面板;任务状态是全局单例)。
let _last = null; // { snap, planTasks, lines }

/**
 * 按 (snap 字符串值, planTasks 引用) 单槽记忆 mergeTaskLines 输出。绝不抛。
 *
 * @param {string} snap - taskStore.snapshot() 文本(每 render 新构建的字符串,按值比较)
 * @param {*} planTasks - panelState.getTasks() 结果(按引用比较)
 * @param {Function} computeFn - () => lines[],即 mergeTaskLines(snap, planTasks) 闭包
 * @param {object} [env]
 * @returns {Array}
 */
function memoMergeTaskLines(snap, planTasks, computeFn, env = process.env) {
  try {
    if (!isEnabled(env)) return computeFn();
    if (_last && _last.snap === snap && _last.planTasks === planTasks) return _last.lines;
    const lines = computeFn();
    _last = { snap, planTasks, lines };
    return lines;
  } catch {
    try { return computeFn(); } catch { return []; }
  }
}

// 测试辅助:清空单槽(避免跨用例串味)。生产不调用。
function _reset() { _last = null; }

module.exports = { isEnabled, memoMergeTaskLines, _reset, OFF_VALUES };
