'use strict';

/**
 * contextRouter.js — Preemptive context overflow routing.
 *
 * Evaluates total token usage BEFORE sending to AI and selects
 * the optimal strategy to stay within budget.
 *
 * Ported from OpenClaw's preemptive-compaction.ts:
 * 4 routes: fits | compact_only | truncate_tool_results_only | compact_then_truncate
 *
 * Constants (from OpenClaw):
 *   SAFETY_MARGIN = 1.2
 *   SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5
 *   PREEMPTIVE_OVERFLOW_RATIO = 0.9
 *   TRUNCATION_ROUTE_BUFFER_TOKENS = 512
 */

const { estimateTokens } = require('./contextWasm');
let _contentToText;
try { _contentToText = require('./contentBlockUtils').contentToText; } catch { _contentToText = (c) => String(c || ''); }

const SAFETY_MARGIN = 1.2;
const PREEMPTIVE_RATIO = 0.9;
const SINGLE_RESULT_SHARE = 0.5;
const TRUNCATION_BUFFER = 512;
// A3: 硬地板 — 低 token 时不触发压缩，保护 prefix cache（学习自 DeepSeek-TUI 500K 硬地板）
// 动态化：与模型 context window 成比例，小模型不会因 floor > budget 永不压缩
const HARD_FLOOR_TOKENS_DEFAULT = Number(process.env.KHY_CONTEXT_HARD_FLOOR) || 32768;
function getHardFloor(contextBudget) {
  if (!Number.isFinite(contextBudget) || contextBudget <= 0) return HARD_FLOOR_TOKENS_DEFAULT;
  return Math.min(HARD_FLOOR_TOKENS_DEFAULT, Math.floor(contextBudget * 0.15));
}

/**
 * Sum token count of all tool result messages.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number}
 */
function sumToolResultTokens(messages) {
  let total = 0;
  for (const m of messages) {
    if (m.role === 'tool') {
      total += estimateTokens(_contentToText(m.content));
    }
  }
  return total;
}

/**
 * Determine the routing strategy for context management.
 *
 * @param {Array<{role: string, content: string}>} messages - Conversation messages
 * @param {string} systemPrompt - Full system prompt
 * @param {string} userPrompt - Current user input
 * @param {number} contextBudget - Max tokens allowed
 * @returns {{ route: string, overflow: number, toolResultTokens: number }}
 */
function routeContextStrategy(messages, systemPrompt, userPrompt, contextBudget) {
  const msgTokens = messages.reduce((sum, m) => sum + estimateTokens(_contentToText(m.content)), 0);
  const sysTokens = estimateTokens(systemPrompt);
  const userTokens = estimateTokens(userPrompt);
  const totalTokens = Math.ceil((msgTokens + sysTokens + userTokens) * SAFETY_MARGIN);

  // A3: 硬地板 — 低 token 时直接返回 fits，不触发任何压缩
  if (totalTokens < getHardFloor(contextBudget)) {
    return { route: 'fits', overflow: 0, toolResultTokens: 0 };
  }

  const threshold = Math.floor(contextBudget * PREEMPTIVE_RATIO);
  const overflow = totalTokens - threshold;

  if (overflow <= 0) {
    return { route: 'fits', overflow: 0, toolResultTokens: 0 };
  }

  const toolResultTokens = sumToolResultTokens(messages);

  // No tool results to truncate — can only compact
  if (toolResultTokens === 0) {
    return { route: 'compact_only', overflow, toolResultTokens: 0 };
  }

  // How much can we save by truncating tool results (cap each at 50%)?
  const reducible = Math.floor(toolResultTokens * SINGLE_RESULT_SHARE);

  if (reducible >= overflow + TRUNCATION_BUFFER) {
    return { route: 'truncate_tool_results_only', overflow, toolResultTokens };
  }

  return { route: 'compact_then_truncate', overflow, toolResultTokens };
}

/**
 * Truncate oversized tool results in-place.
 * Caps each tool result at `maxTokensPerResult` tokens.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} targetReduction - How many tokens to save
 */
function truncateToolResults(messages, targetReduction) {
  let saved = 0;

  for (let i = 0; i < messages.length && saved < targetReduction; i++) {
    // 结构化 tool_result（role='user', content 含 tool_result blocks）
    if (messages[i].role === 'user' && Array.isArray(messages[i].content)
        && messages[i].content.some(b => b && b.type === 'tool_result')) {
      for (const block of messages[i].content) {
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          const tokens = estimateTokens(block.content);
          const maxTokens = Math.floor(tokens * SINGLE_RESULT_SHARE);
          if (tokens > maxTokens) {
            const maxChars = maxTokens * 4;
            const lastNewline = block.content.lastIndexOf('\n', maxChars);
            const cutPos = (lastNewline > maxChars * 0.5) ? lastNewline : maxChars;
            const omitted = block.content.length - cutPos;
            block.content = block.content.slice(0, cutPos) + `\n... [truncated ${omitted} chars]`;
            saved += tokens - estimateTokens(block.content);
          }
        }
      }
      continue;
    }

    if (messages[i].role !== 'tool') continue;

    const content = _contentToText(messages[i].content);
    const tokens = estimateTokens(content);
    const maxTokens = Math.floor(tokens * SINGLE_RESULT_SHARE);

    if (tokens > maxTokens) {
      // Character-level truncation (4 chars ≈ 1 token)
      const maxChars = maxTokens * 4;
      // Find last newline before maxChars for clean cut
      let cutPos = maxChars;
      const lastNewline = content.lastIndexOf('\n', maxChars);
      if (lastNewline > maxChars * 0.5) {
        cutPos = lastNewline;
      }

      const omitted = content.length - cutPos;
      messages[i] = {
        role: 'tool',
        content: content.slice(0, cutPos) + `\n... [truncated ${omitted} chars]`,
      };
      saved += tokens - estimateTokens(messages[i].content);
    }
  }

  return saved;
}

module.exports = {
  routeContextStrategy,
  truncateToolResults,
  sumToolResultTokens,
  SAFETY_MARGIN,
  PREEMPTIVE_RATIO,
  SINGLE_RESULT_SHARE,
  HARD_FLOOR_TOKENS: HARD_FLOOR_TOKENS_DEFAULT,
  getHardFloor,
};
