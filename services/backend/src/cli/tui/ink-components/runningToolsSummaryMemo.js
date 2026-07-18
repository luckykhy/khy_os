'use strict';

/**
 * runningToolsSummaryMemo — 按 tool 对象身份记忆工具分类,消除聚合状态播报每帧对**整条工具数组**的重复分类。
 *
 * 承 keystroke/frame 流畅性同族(渲染热路径每帧重复计算消除):
 * [[toolTargetMemo]](同 WeakMap-by-tool-identity 记法)· streamNormCache · liveTimelineLazyNorm。
 *
 * 根因(每帧 O(n) 重复分类):`StreamingBlock.js` 每帧(~25fps)调
 * `buildLiveStatusBroadcast(streaming.tools)` → `summarizeRunningTools(tools)`,后者对**整条**
 * `streaming.tools`(全轮累积、随轮增长)先 `.filter(_isRunning)` 再对每个在跑工具调
 * `classifyAgentTool(name)`(`String(name).toLowerCase().replace(/[\s_-]/g,'')` + 最多 ~7 条正则 `.test`)。
 * 但工具的 `name` 恒定不变(分类是 name 的纯函数),已到达工具每帧重跑 toLowerCase/replace/regex 纯浪费;
 * 工具越多越靠后累积成可感每帧开销(长轮 O(n²)/轮)。
 *
 * 修:按 **tool 对象身份**(WeakMap)记忆 `classifyAgentTool(name)` 的纯输出(类别字符串,不可变)。
 * 已到达工具命中缓存跳过分类正则;`_isRunning` 判定仍每帧现读(工具 `result` 会 running→done 转变,
 * 但**分类与 running 无关**,故缓存分类在状态转变后依然正确)。分类器由调用方注入(叶子不 require
 * agentTreeView,保持零耦合),缺失/异常 → 直接调注入分类器(逐字节回退)。
 *
 * 纯叶子纪律:零 IO、确定性、绝不抛;门控关 → 每工具直接调注入分类器(逐字节回退今日行为)。
 *
 * 门控 `KHY_RUNNING_TOOLS_SUMMARY_MEMO` 默认开;关 → 每帧全量分类,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_RUNNING_TOOLS_SUMMARY_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// 第二层门控:按 streaming.tools **数组对象身份**整体记忆 counts(见 summarizeRunningByArrayIdentity)。
// 与第一层(classifyTool 按 tool 身份记忆分类)正交、可独立回退。
function isArrayMemoEnabled(env = process.env) {
  const raw = env && env.KHY_RUNNING_TOOLS_ARRAY_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// tool 对象 → 已算类别字符串(WeakMap 防泄漏)。分类是 name 的纯函数,name 恒定 → 缓存永不陈旧。
const _classifyCache = new WeakMap();

/**
 * 取工具类别,按 tool 对象身份记忆(命中跳过分类器的 toLowerCase/replace/regex)。
 * @param {object} toolObj    稳定 tool 对象(键)
 * @param {string} name       工具名(分类器输入)
 * @param {(name:string)=>string} classifyFn 注入的分类器(如 agentTreeView.classifyAgentTool)
 * @param {object} [env]
 * @returns {string} 类别字符串
 */
function classifyTool(toolObj, name, classifyFn, env = process.env) {
  try {
    if (!isEnabled(env) || !toolObj || typeof toolObj !== 'object') return classifyFn(name);
    const cached = _classifyCache.get(toolObj);
    if (cached !== undefined) return cached;
    const cat = classifyFn(name);
    _classifyCache.set(toolObj, cat);
    return cat;
  } catch {
    try { return classifyFn(name); } catch { return 'other'; }
  }
}

/**
 * 统计在跑工具按类别的计数(与历史 summarizeRunningTools 逐字节等价的输出),但分类经对象身份记忆。
 *
 * @param {Array} tools           streaming.tools
 * @param {(t:any)=>boolean} isRunningFn  在跑判定(与 _isRunning 一致)
 * @param {(t:any)=>string} nameFn        取工具名(与 _toolName 一致)
 * @param {(name:string)=>string} classifyFn  分类器(agentTreeView.classifyAgentTool)
 * @param {object} [env]
 * @returns {Object<string,number>} 类别 → 计数
 */
function summarizeRunning(tools, isRunningFn, nameFn, classifyFn, env = process.env) {
  const counts = Object.create(null);
  if (!Array.isArray(tools)) return counts;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    let running;
    try { running = !!isRunningFn(t); } catch { running = false; }
    if (!running) continue;
    let name;
    try { name = nameFn(t); } catch { name = ''; }
    const cat = classifyTool(t, name, classifyFn, env);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

// streaming.tools 数组对象 → 已算 counts(WeakMap 防泄漏)。
//
// 根因(承 [[project_running_tools_summary_memo_frame]] 之后剩余的每帧 O(turn) 扫描):
// classifyTool 已按 tool 身份记忆掉了分类正则,但 summarizeRunning 的**外层循环本身**每帧仍对
// **整条**(全轮累积、随轮增长的)streaming.tools 走一遍 isRunningFn(t)(= `!t.result`,便宜的属性读)
// 并重建 counts 对象。长轮里工具累积到上千,这层 O(turn)/帧 × ~25fps = O(turn²)/turn 的属性读 + 每帧
// 一个新 counts 对象分配,是命中路径上仍在跑的最后一段每帧churn。
//
// 关键不变量(取证 useQueryBridge.js:494/506):streaming.tools 在**追加**(`[...s.tools, tool]`)或
// **解析**(`s.tools.map(...)` 重建)时得到**新数组引用**;而在纯文本流入的帧(~25fps 主流场景,tools 未变)
// 保持**同一数组引用**。因此:同一数组引用 ⟺ 可证 counts 完全相同 ⟹ 命中即整体复用跳过全扫描;
// 新数组引用 ⟹ 重算一次。counts 仅被 buildLiveStatusBroadcast **只读**消费(读 counts[cat]),
// 故跨帧复用同一对象安全。
//
// 门控 KHY_RUNNING_TOOLS_ARRAY_MEMO(默认开)关 → 直接调 summarizeRunning(逐字节回退今日行为)。
const _arrayCache = new WeakMap();

/**
 * 按 streaming.tools 数组对象身份整体记忆 counts。文本流入帧(tools 引用不变)命中缓存,
 * 跳过对整条数组的 O(turn) 在跑扫描;tools 变更(追加/解析 → 新数组引用)时重算一次。
 *
 * 逐字节等价:命中返回的 counts 恰是上次 summarizeRunning(同一数组) 的结果;门控关直接透传。
 *
 * @param {Array} tools           streaming.tools
 * @param {(t:any)=>boolean} isRunningFn
 * @param {(t:any)=>string} nameFn
 * @param {(name:string)=>string} classifyFn
 * @param {object} [env]
 * @returns {Object<string,number>} 类别 → 计数
 */
function summarizeRunningByArrayIdentity(tools, isRunningFn, nameFn, classifyFn, env = process.env) {
  try {
    // 门控关、或 tools 非对象(无法作 WeakMap 键)→ 逐字节回退直接全扫描。
    if (!isArrayMemoEnabled(env) || !tools || typeof tools !== 'object') {
      return summarizeRunning(tools, isRunningFn, nameFn, classifyFn, env);
    }
    const cached = _arrayCache.get(tools);
    if (cached !== undefined) return cached;
    const counts = summarizeRunning(tools, isRunningFn, nameFn, classifyFn, env);
    _arrayCache.set(tools, counts);
    return counts;
  } catch {
    // 任何异常 → 回退全扫描(绝不抛)。
    try { return summarizeRunning(tools, isRunningFn, nameFn, classifyFn, env); }
    catch { return Object.create(null); }
  }
}

module.exports = {
  isEnabled,
  isArrayMemoEnabled,
  classifyTool,
  summarizeRunning,
  summarizeRunningByArrayIdentity,
  OFF_VALUES,
};
