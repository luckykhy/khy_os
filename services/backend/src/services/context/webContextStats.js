'use strict';

/**
 * webContextStats.js —— Web 聊天(AIChat.vue)上下文用量统计(纯叶子)。
 *
 * 把 CC 上下文可视化专项包的**后端逻辑**延伸到前端聊天界面:给定一段会话
 * 消息(前端持有的实时 transcript),计算
 *   · per-category 分解(System tools / User / Assistant / Tool calls / Tool results);
 *   · 总占用 token、占用百分比、剩余 token;
 *   · per-tool-call 分解(哪个工具吃了多少 token);
 *   · 可操作优化建议(near-capacity → /compact、大工具结果、Read 膨胀 …)。
 *
 * 复用既有两纯叶子的后端逻辑,不重复实现:
 *   - cli/messageBreakdown.js  → approximateMessageTokens 移植(真实 per-tool 分解)
 *   - cli/contextSuggestions.js → generateContextSuggestions 移植(建议规则)
 *
 * 纯叶子:零 IO、确定性、绝不抛。estimateTokens 与 toolDefsJson 由调用方注入
 * (token 估算走 SSOT services/textHeuristics;工具 schema JSON 由注册表提供)。
 * 门控 KHY_WEB_CONTEXT_STATS 默认开;关 → 返回 null,调用方省略该字段(字节回退)。
 */

const { analyzeMessageBreakdown } = require('./messageBreakdown');
const { analyzeContextSuggestions } = require('./contextSuggestions');

const DEFAULT_CONTEXT_WINDOW = 200000; // Claude 家族常见默认,仅在既无入参也无 env 时兜底。

function webContextStatsEnabled(env = process.env) {
  const raw = env && env.KHY_WEB_CONTEXT_STATS;
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function _num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

// 解析上下文窗口上限:显式入参优先 → KHY_CONTEXT_WINDOW 环境变量 → 家族默认。
function _resolveContextWindow(input, env) {
  const explicit = _num(input && input.contextWindow);
  if (explicit > 0) return Math.floor(explicit);
  const fromEnv = _num(env && env.KHY_CONTEXT_WINDOW);
  if (fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 计算 Web 聊天上下文用量统计。
 *
 * @param {object} input
 * @param {Array<{role:string, content:(string|Array)}>} input.messages 会话消息(实时 transcript)。
 * @param {number} [input.contextWindow] 上下文窗口上限 token(缺省走 env / 默认)。
 * @param {string} [input.toolDefsJson] 工具定义 JSON 串(= System tools 类别真实开销)。
 * @param {function(string):number} input.estimateTokens token 估算器(SSOT 注入)。
 * @param {boolean} [input.isAutoCompactEnabled] 是否启用自动压缩(影响 near-capacity 建议文案)。
 * @param {object} [env]
 * @returns {null | {
 *   totalTokens:number, contextWindow:number, percentage:number, remainingTokens:number,
 *   categories:Array<{name:string, tokens:number}>,
 *   toolCallsByType:Array<{name:string, callTokens:number, resultTokens:number}>,
 *   suggestions:Array<object>
 * }} 门控关 → null。
 */
function analyzeWebContextStats(input = {}, env = process.env) {
  if (!webContextStatsEnabled(env)) return null;
  if (!input || typeof input !== 'object') return null;

  const estimate = typeof input.estimateTokens === 'function' ? input.estimateTokens : null;
  if (!estimate) return null;

  const contextWindow = _resolveContextWindow(input, env);
  const messages = Array.isArray(input.messages) ? input.messages : [];

  // 1) per-tool / per-role token 分解(真实数据源:传入的实时 transcript)。
  let mb = null;
  try {
    mb = analyzeMessageBreakdown({ messages, estimateTokens: estimate }, env);
  } catch { /* 分解 best-effort */ }
  const bd = mb || {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: [],
  };
  const toolCallsByType = Array.isArray(bd.toolCallsByType) ? bd.toolCallsByType : [];

  // 2) System tools 类别 = 发给模型的工具 schema JSON 的真实开销。
  let systemToolsTokens = 0;
  if (input.toolDefsJson && typeof input.toolDefsJson === 'string') {
    try { systemToolsTokens = _num(estimate(input.toolDefsJson)); } catch { systemToolsTokens = 0; }
  }

  // 3) 组装分类(省略 0 token 的类别 = honest,不显示空条目)。
  const rawCategories = [
    { name: 'System tools', tokens: systemToolsTokens },
    { name: 'User messages', tokens: _num(bd.userMessageTokens) },
    { name: 'Assistant messages', tokens: _num(bd.assistantMessageTokens) },
    { name: 'Tool calls', tokens: _num(bd.toolCallTokens) },
    { name: 'Tool results', tokens: _num(bd.toolResultTokens) },
  ];
  const categories = rawCategories.filter((c) => c.tokens > 0);

  const totalTokens = systemToolsTokens + _num(bd.totalTokens);
  const percentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;
  const remainingTokens = Math.max(0, contextWindow - totalTokens);

  // 4) 可操作优化建议(复用 contextSuggestions 规则)。
  let suggestions = [];
  try {
    suggestions = analyzeContextSuggestions(
      {
        percentage,
        contextWindow,
        categories,
        toolCallsByType,
        isAutoCompactEnabled:
          typeof input.isAutoCompactEnabled === 'boolean' ? input.isAutoCompactEnabled : null,
      },
      env,
    ) || [];
  } catch { suggestions = []; }

  return {
    totalTokens,
    contextWindow,
    percentage,
    remainingTokens,
    categories,
    toolCallsByType,
    suggestions,
  };
}

module.exports = {
  webContextStatsEnabled,
  analyzeWebContextStats,
  DEFAULT_CONTEXT_WINDOW,
};
