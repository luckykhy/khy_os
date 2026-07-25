'use strict';

// processGroupClassifyMemo.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 ProcessGroup 每帧对**分组内每个工具**重复运行 classifyTool 的正则电池。
//
// 背景(承 [[toolTargetMemo]] 同族):流式渲染时父 App 每帧(~25fps)重渲,ProcessGroup(plain
// function,**未 React.memo**)每帧对可见尾窗里每个工具组算 `groupTitle(tools)`。groupTitle 对组内
// 每个工具调 `classifyTool(name)`,后者做 `_normName`(toLowerCase + `replace(/[^a-z]/g,'')`)+ 命中
// EXPLICIT_CATEGORY Map 未中则遍历 CATEGORY_RULES(**最多 ~13 条正则 `.test`**)。但工具 `name` 恒定
// 不变(分类是 name 的纯函数),已到达工具每帧重跑这套正则纯浪费——组内工具越多、帧越密,累积成
// 可感每帧开销。
//
// 关键:`tools` **数组**每帧由 groupConsecutiveTools/groupTimeline 新建(数组身份每帧变 → 数组级 memo
// 每帧 miss),但数组内的 **tool 对象**对已到达工具是稳定引用。故按 **tool 对象身份**(WeakMap)记忆
// `classifyTool(name)` 的纯输出(类别字符串或 null,不可变、天然可共享)。分类与工具 running/result 状态
// 无关,故 result 从 running→done 转变后缓存分类依然正确(不取陈旧)。computeFn 由调用方注入(叶子不
// require ProcessGroup 自身,避免循环)。门控 KHY_PROCESS_GROUP_CLASSIFY_MEMO 默认开;关 → 直接
// computeFn()(逐字节回退今日)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_PROCESS_GROUP_CLASSIFY_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// toolObj -> 已算类别(string | null)。用 has()/get() 区分「已缓存 null」与「未缓存」,
// 避免对返回 null 的工具每帧重算。
const _cache = new WeakMap();

/**
 * 按 tool 对象身份记忆 classifyTool 的纯输出。绝不抛(异常 → 尽力 computeFn(),再异常 → null)。
 *
 * @param {object} toolObj - 稳定 tool 对象键。非对象/假值 → 不缓存直算。
 * @param {Function} computeFn - () => (string|null),原 classifyTool(name) 闭包
 * @param {object} [env]
 * @returns {string|null}
 */
function memoClassify(toolObj, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !toolObj || typeof toolObj !== 'object') return computeFn();
    if (_cache.has(toolObj)) return _cache.get(toolObj);
    const cat = computeFn();
    _cache.set(toolObj, cat);
    return cat;
  } catch {
    try { return computeFn(); } catch { return null; }
  }
}

module.exports = { isEnabled, memoClassify, OFF_VALUES };
