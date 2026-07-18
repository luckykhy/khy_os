'use strict';

// toolTargetMemo.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 ProcessGroup 每帧对**已完成工具** input 的重复 JSON.parse。
//
// 背景(诊断,承 toolDiffRowsMemo 同族):流式渲染时父 App 每帧(~25fps)重渲,ProcessGroup
// (plain function,未 React.memo)对可见尾窗里每个工具组重算 groupTitle → representativeTarget →
// `tools.map(toolTarget)`。`toolTarget(t)`(ProcessGroup.js:105)在 `t.input` 为字符串时做 `JSON.parse`
// 抽取操作目标(command/file_path/…)。但已完成工具的 `t`(及其 input 字符串)是**冻结快照**,每帧
// 重 parse 纯浪费——工具越多、越靠后,累积成可感浪费。
//
// 关键:`tools` **数组**每帧由 groupConsecutiveTools 新建(数组身份变 → 数组级 memo 每帧 miss),但
// 数组内的 **tool 对象**对已完成工具是稳定引用。故按 **tool 对象身份**(WeakMap)记忆 `toolTarget` 的
// 纯输出(字符串,不可变、天然可共享)。冻结工具命中跳过 JSON.parse;运行中工具若每帧换新对象 → miss
// 重算(不取陈旧)。computeFn 由调用方注入(叶子不 require ProcessGroup)。门控 KHY_TOOL_TARGET_MEMO
// 默认开;关 → 直接 computeFn()(逐字节回退今日)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TOOL_TARGET_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

const _cache = new WeakMap(); // toolObj -> computed target string

/**
 * 按 tool 对象身份记忆 toolTarget 的纯输出。绝不抛(异常 → 尽力 computeFn(),再异常 → '')。
 *
 * @param {object} toolObj - 稳定 tool 对象键。非对象/假值 → 不缓存直算。
 * @param {Function} computeFn - () => string,原 toolTarget(t) 闭包
 * @param {object} [env]
 * @returns {string}
 */
function memoToolTarget(toolObj, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !toolObj || typeof toolObj !== 'object') return computeFn();
    if (_cache.has(toolObj)) return _cache.get(toolObj);
    const target = computeFn();
    _cache.set(toolObj, target);
    return target;
  } catch {
    try { return computeFn(); } catch { return ''; }
  }
}

// toolObj -> 已算「压缩目标」(condenseTarget 输出)。承 memoToolTarget:representativeTarget 在拿到
// 每工具原始目标后还要 `condenseTarget(target)`(`/[/\\]/` 测试 + split/filter 取 basename,每帧对组内
// 每工具分配新数组)。压缩目标是**冻结工具**原始目标(已冻结)的纯函数,故按同一 tool 对象身份记忆,
// 把 target-memo 覆盖从「原始目标」延伸到「压缩目标」,每帧对已到达工具连 condense 也跳过。同门控
// KHY_TOOL_TARGET_MEMO、同 WeakMap 身份键族。
const _condensedCache = new WeakMap(); // toolObj -> condensed target string

/**
 * 按 tool 对象身份记忆 condenseTarget 的纯输出。绝不抛(异常 → 尽力 computeFn(),再异常 → '')。
 *
 * @param {object} toolObj - 稳定 tool 对象键。非对象/假值 → 不缓存直算。
 * @param {Function} computeFn - () => string,原 condenseTarget(toolTarget(t)) 闭包
 * @param {object} [env]
 * @returns {string}
 */
function memoCondensedTarget(toolObj, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !toolObj || typeof toolObj !== 'object') return computeFn();
    if (_condensedCache.has(toolObj)) return _condensedCache.get(toolObj);
    const condensed = computeFn();
    _condensedCache.set(toolObj, condensed);
    return condensed;
  } catch {
    try { return computeFn(); } catch { return ''; }
  }
}

module.exports = { isEnabled, memoToolTarget, memoCondensedTarget, OFF_VALUES };
