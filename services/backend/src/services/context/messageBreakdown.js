'use strict';

/**
 * messageBreakdown.js —— 会话消息的 per-tool-type token 分解(纯叶子)。
 *
 * 移植自 Claude Code `src/utils/analyzeContext.ts` 的 `approximateMessageTokens`
 * / `processAssistantMessage` / `processUserMessage`:遍历会话消息数组,把每个
 * content block 按 `estimateTokens(JSON.stringify(block))` 计入分类:
 *   · assistant 的 tool_use 块 → toolCallsByType[name].callTokens
 *   · user/tool 的 tool_result 块 → toolResultsByType[name].resultTokens
 *     (经 tool_use_id → 工具名映射;映射不到记 'unknown')
 *   · 其余文本块 → assistant/user message tokens
 *
 * 产出被 contextSuggestions.js 的「大工具结果 / Read 膨胀」检查消费,把此前
 * 的 honest-NA 兜底升级为**真实数据**(数据源 = ai.js getConversation() 的
 * 活动 _messages 快照)。
 *
 * 纯叶子:零 IO、确定性、绝不抛;messages 与 estimateTokens 均由调用方注入。
 * 门控 KHY_MESSAGE_BREAKDOWN 默认开;关闭 → 返回 null(调用方回退 honest-NA)。
 */

function messageBreakdownEnabled(env = process.env) {
  const raw = env && env.KHY_MESSAGE_BREAKDOWN;
  if (raw == null) return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function _num(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function _blockTokens(block, estimate) {
  let s;
  try {
    s = typeof block === 'string' ? block : JSON.stringify(block);
  } catch {
    s = '';
  }
  try {
    return _num(estimate(s || ''));
  } catch {
    return 0;
  }
}

/**
 * 计算会话消息的 per-tool-type token 分解。
 *
 * @param {object} input
 * @param {Array<{role:string, content:string|Array}>} input.messages  会话消息快照。
 * @param {function} input.estimateTokens  文本 → token 估算器(SSOT)。
 * @param {object} [env]
 * @returns {null | {
 *   totalTokens:number, toolCallTokens:number, toolResultTokens:number,
 *   assistantMessageTokens:number, userMessageTokens:number,
 *   toolCallsByType: Array<{name:string, callTokens:number, resultTokens:number}>
 * }}
 *   门控关 / 无消息 / 无估算器 → null。
 */
function analyzeMessageBreakdown(input = {}, env = process.env) {
  if (!messageBreakdownEnabled(env)) return null;
  if (!input || typeof input !== 'object') return null;

  const messages = Array.isArray(input.messages) ? input.messages : null;
  const estimate = typeof input.estimateTokens === 'function' ? input.estimateTokens : null;
  if (!messages || messages.length === 0 || !estimate) return null;

  const callByName = new Map();   // name → callTokens
  const resultByName = new Map(); // name → resultTokens
  const idToName = new Map();     // tool_use_id → tool name
  let toolCallTokens = 0;
  let toolResultTokens = 0;
  let assistantMessageTokens = 0;
  let userMessageTokens = 0;

  // 先建 tool_use_id → name 映射(对齐 CC:先扫一遍再计 result)。
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        const name = (typeof block.name === 'string' && block.name) || 'unknown';
        if (id) idToName.set(id, name);
      }
    }
  }

  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;
    const role = msg.role;

    // 字符串内容 → 纯文本,计入对应角色。
    if (typeof content === 'string') {
      const t = _blockTokens(content, estimate);
      if (role === 'assistant') assistantMessageTokens += t;
      else userMessageTokens += t;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') {
        // 非对象块(如纯字符串元素)计入对应角色文本。
        const t = _blockTokens(block, estimate);
        if (role === 'assistant') assistantMessageTokens += t;
        else userMessageTokens += t;
        continue;
      }
      const t = _blockTokens(block, estimate);
      if (block.type === 'tool_use') {
        toolCallTokens += t;
        const name = (typeof block.name === 'string' && block.name) || 'unknown';
        callByName.set(name, (callByName.get(name) || 0) + t);
      } else if (block.type === 'tool_result') {
        toolResultTokens += t;
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const name = (id && idToName.get(id)) || 'unknown';
        resultByName.set(name, (resultByName.get(name) || 0) + t);
      } else {
        if (role === 'assistant') assistantMessageTokens += t;
        else userMessageTokens += t;
      }
    }
  }

  // 合并 call/result 两表为统一数组(按 callTokens+resultTokens 降序)。
  const names = new Set([...callByName.keys(), ...resultByName.keys()]);
  const toolCallsByType = [...names]
    .map((name) => ({
      name,
      callTokens: callByName.get(name) || 0,
      resultTokens: resultByName.get(name) || 0,
    }))
    .sort((a, b) => (b.callTokens + b.resultTokens) - (a.callTokens + a.resultTokens));

  const totalTokens =
    toolCallTokens + toolResultTokens + assistantMessageTokens + userMessageTokens;

  return {
    totalTokens,
    toolCallTokens,
    toolResultTokens,
    assistantMessageTokens,
    userMessageTokens,
    toolCallsByType,
  };
}

module.exports = {
  messageBreakdownEnabled,
  analyzeMessageBreakdown,
};
