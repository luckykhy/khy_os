'use strict';

/**
 * statusBroadcast — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 把「此刻同时在跑的工具集合」融成 Claude Code 那一行现在进行时的「状态播报」,例如:
 *   "正在搜索 1 个模式、读取 1 个文件…"   ←  Searching for 1 pattern, reading 1 file…
 *   "正在列出 1 个目录…"                  ←  Listing 1 directory…
 *   "正在读取 3 个文件…"                  ←  Reading 3 files…
 *
 * 缘由:Khy 早已**逐工具**叙述(toolPrefaceVoice.toolRunningNarration → 每行下面的
 * "正在读取 X…"),缺的是 CC 在多个工具并发时压在最上方的那一条**聚合**活动行。本叶子
 * 只负责算出那一行——不渲染、不碰 IO、绝不抛;门控关或无在跑工具时返 ''(→ 不出这一行),
 * 因此门控关与改动前 UI 逐字节等价。
 *
 * 工具分类**复用** agentTreeView.classifyAgentTool(单一真源,叶子→叶子相对 require 合规),
 * 绝不在此另造一份分类器(避免「堆砌」式重复)。
 *
 * 门控:KHY_STATUS_BROADCAST(默认开)。=0/false/off/no → '' (字节回退)。
 */

const { classifyAgentTool } = require('./agentTreeView');

function _enabled(env = process.env) {
  const flag = String((env && env.KHY_STATUS_BROADCAST) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// classifyAgentTool 的类别 → 现在进行时片段 { verb, noun }。下面 CATEGORY_ORDER 是
// **确定性显示顺序**,与工具到达顺序无关,这样同一组在跑工具永远渲染成同一行(可单测、
// 无抖动)。
//
// 顺序对齐 CC 源 `src/utils/collapseReadSearch.ts` 的 `getSearchReadSummaryText`
// (:1033)的**权威类别次序**:memory → search → **read → list** → repl(parts 依次
// push:Searching for N patterns → reading M files → listing K directories)。早先无源时
// 凭记忆「Searching …, reading …」近似,误把 listing 排在 read **之前**;现据 CC 源更正为
// **search → read → listing**(read 必在 list 前)。Khy 独有的 edit/command/agent/other
//(CC 聚合不含、会打断折叠)排在 CC 三档之后——这是 Khy「并发在跑工具」面的设计(与 CC
//「尾部可折叠串」面不同),刻意保留。
const CATEGORY_PHRASE = Object.freeze({
  search: { verb: '搜索', noun: '个模式' },
  read: { verb: '读取', noun: '个文件' },
  listing: { verb: '列出', noun: '个目录' },
  edit: { verb: '修改', noun: '个文件' },
  command: { verb: '执行', noun: '条命令' },
  agent: { verb: '运行', noun: '个子任务' },
  other: { verb: '处理', noun: '项' },
});
const CATEGORY_ORDER = Object.freeze(['search', 'read', 'listing', 'edit', 'command', 'agent', 'other']);

function _toolName(t) {
  return (t && (t.name || t.toolName)) || '';
}

// 一行工具视为「在跑」当且仅当它还没挂上 result(与 reduceToolResult 的不变量一致)。
function _isRunning(t) {
  return !!t && !t.result;
}

/**
 * 统计在跑工具按类别的计数。纯函数;非数组/空 → {}。
 *
 * 流畅性(frame):StreamingBlock 每帧(~25fps)对**整条** streaming.tools 走此函数;历史实现每帧对每个
 * 在跑工具重跑 classifyAgentTool(toLowerCase/replace/~7 正则)。工具 name 恒定 → 分类可按对象身份记忆。
 * 经 runningToolsSummaryMemo.summarizeRunningByArrayIdentity:先按 streaming.tools **数组对象身份**整体
 * 记忆 counts(文本流入帧 tools 引用不变 → 命中即跳过整条 O(turn) 在跑扫描),未命中再走
 * summarizeRunning(内层已按 tool 身份记忆分类)。叶子加载/异常 → 回退内联历史实现(逐字节等价)。
 * @param {Array<{name?:string,toolName?:string,result?:any}>} tools
 * @returns {Object<string,number>}
 */
let _summaryMemo;
function summarizeRunningTools(tools, env = process.env) {
  try {
    if (_summaryMemo === undefined) {
      try { _summaryMemo = require('./tui/ink-components/runningToolsSummaryMemo'); }
      catch { _summaryMemo = null; }
    }
    if (_summaryMemo) {
      return _summaryMemo.summarizeRunningByArrayIdentity(tools, _isRunning, _toolName, classifyAgentTool, env);
    }
  } catch { /* 回退内联历史实现 */ }
  // 历史内联实现(叶子不可用 / 门控关时的逐字节回退)。
  const list = Array.isArray(tools) ? tools.filter(_isRunning) : [];
  const counts = Object.create(null);
  for (const t of list) {
    const cat = classifyAgentTool(_toolName(t));
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return counts;
}

/**
 * 构造聚合状态播报行。门控关、无在跑工具、或全被归零 → ''(调用方据此不渲染)。
 * @param {Array} tools  streaming.tools(在跑行 result 缺失)
 * @param {{env?:object}} [options]
 * @returns {string}  形如 "正在搜索 1 个模式、读取 1 个文件…"  或 ''
 */
function buildLiveStatusBroadcast(tools, options = {}) {
  const env = (options && options.env) || process.env;
  if (!_enabled(env)) return '';
  const counts = summarizeRunningTools(tools, env);
  const parts = [];
  for (const cat of CATEGORY_ORDER) {
    const n = counts[cat];
    if (!n) continue;
    const phrase = CATEGORY_PHRASE[cat];
    parts.push(`${phrase.verb} ${n} ${phrase.noun}`);
  }
  if (parts.length === 0) return '';
  return `正在${parts.join('、')}…`;
}

module.exports = {
  buildLiveStatusBroadcast,
  summarizeRunningTools,
  CATEGORY_PHRASE,
  CATEGORY_ORDER,
};
