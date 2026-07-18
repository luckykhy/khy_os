'use strict';

// toolHeaderSummaryMemo.js — pure leaf (zero IO beyond an injected cwd key, deterministic, never throws).
//
// 目的:消除 ToolLines 每帧对 live 尾窗里每个工具**头行**的重复构造——显示名归一
// (resolveToolHeaderName)+ 入参摘要(summarizeArgs)。与姊妹叶子 toolTargetMemo(记忆
// ProcessGroup 组标题的 toolTarget)、toolDiffRowsMemo / toolLiteralOutputMemo(记忆结果体)
// 互补,合起来把工具子树的每帧纯计算全部收敛。
//
// 背景(诊断,承 [[toolTargetMemo]] 同族):流式渲染时父 App 每帧(~25fps)重渲,ToolLines
// (plain function,未 React.memo)对 `tools.map` 里每个工具都重跑头行两处纯计算:
//   ① `resolveToolHeaderName(name, env, getToolDisplayName)`(:577)—— 每帧 2 次 require + 主题查表;
//   ② `summarizeArgs(t)`(:582)—— 取 input;字符串则 `JSON.parse`(大 JSON 入参即每帧 O(input));
//      path 类键还 `require('../../ccRelativePath').relativizeToolPath(String, process.cwd(), env)`——
//      **每帧一次 process.cwd() 系统调用** + require + 路径中截。
// 但 tool 的 `name` / `input` 在工具创建后**不再变**(仅 progress/result 后续附加)→ 头行是
// (tool, cwd) 的确定性纯函数,每帧重算是纯浪费——尤其 process.cwd() 系统调用逐帧逐工具地打。
//
// 关键正确性:
//   • 键 = tool 对象身份(WeakMap;已完成工具稳定引用,运行中工具虽原地 mutate 但只加 progress/
//     result,name/input 不变 → 头行仍稳定,取缓存安全)。
//   • cwd 守卫:summarizeArgs 的 path 相对化依赖 process.cwd() → 缓存内记录计算时的 cwd,cwd 变化
//     (用户 cd)→ miss 重算,杜绝陈旧相对路径。调用方在 `tools.map` **外**只取一次 process.cwd()
//     传入(把每帧 N 次系统调用降到 1 次),同一同步 render 内 cwd 恒定 → 键与 summarizeArgs 内部
//     读到的 cwd 必然一致。
//   • 命中返回**同一** header 对象(下游只读 name/argSummary 两字段)→ 逐字节等价。env 变化不使缓存
//     失效——与 toolTargetMemo / toolDiffRowsMemo 同一取舍(env 单会话内稳定)。
//
// 门控 KHY_TOOL_HEADER_SUMMARY_MEMO 默认开;关/异常/非对象 tool → 直接 computeFn()(逐字节回退)。绝不抛。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_TOOL_HEADER_SUMMARY_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 键:tool 对象 → { cwd, header }。header = { name, argSummary }。
const _cache = new WeakMap();

/**
 * 记忆工具头行 { name, argSummary }。键 = tool 对象身份 + cwd 守卫。
 * 绝不抛(异常 → 尽力 computeFn(),再异常 → { name: '', argSummary: '' })。
 *
 * @param {object} tool - 稳定对象键。非对象/假值 → 不缓存直算。
 * @param {string} cwd - 计算时的工作目录(调用方在 map 外取一次传入)。cwd 变 → miss 重算。
 * @param {Function} computeFn - () => { name, argSummary },原头行构造闭包
 * @param {object} [env]
 * @returns {{ name: string, argSummary: string }}
 */
function memoHeader(tool, cwd, computeFn, env = process.env) {
  try {
    if (!isEnabled(env) || !tool || typeof tool !== 'object') return computeFn();
    const hit = _cache.get(tool);
    if (hit && hit.cwd === cwd) return hit.header;
    const header = computeFn();
    _cache.set(tool, { cwd, header });
    return header;
  } catch {
    try { return computeFn(); } catch { return { name: '', argSummary: '' }; }
  }
}

module.exports = { isEnabled, memoHeader, OFF_VALUES };
