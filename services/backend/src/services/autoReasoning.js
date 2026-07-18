'use strict';

/**
 * autoReasoning.js — Auto-Reasoning Effort Selection
 *
 * Aligned with DeepSeek-TUI's keyword-driven effort tier selection.
 * When reasoning_effort="auto", selects tier based on user message keywords.
 *
 * Tiers:
 *   low  — Simple lookups, searches, subagent contexts
 *   high — Default for most tasks
 *   max  — Debugging, error analysis, complex reasoning
 *
 * Multi-locale: English + Simplified/Traditional Chinese + Japanese
 */

// ── Keyword Patterns ──────────────────────────────────────────────────

const LOW_EFFORT_PATTERNS = [
  // English
  /\b(search|lookup|find|list|show|display|what is|who is|where is|check)\b/i,
  // Chinese (Simplified + Traditional)
  /[搜索查找查询查看列出显示展示是什么在哪里看看找找搜一下]/,
  // Japanese
  /[検索調べ探す表示一覧見る確認]/,
];

const MAX_EFFORT_PATTERNS = [
  // English
  /\b(debug|error|bug|fix|crash|panic|segfault|trace|diagnose|investigate|analyze|why does|root cause|stack trace|memory leak)\b/i,
  // Chinese (Simplified + Traditional)
  /[调试除错修复崩溃报错异常诊断分析排查根因故障死锁内存泄漏]/,
  // Japanese
  /[デバッグバグ修正クラッシュエラー診断分析調査原因追跡メモリリーク]/,
];

// ── Effort Resolution ─────────────────────────────────────────────────

/**
 * Resolve reasoning effort tier based on user message content.
 *
 * @param {string} userMessage - The user's input message
 * @param {object} [options]
 * @param {boolean} [options.isSubagent=false] - Whether this is a subagent context
 * @param {string}  [options.override]          - Force a specific tier ('low'|'high'|'max')
 * @returns {'low'|'high'|'max'}
 */
function resolveEffort(userMessage, options = {}) {
  // Explicit override
  if (options.override && ['low', 'high', 'max'].includes(options.override)) {
    return options.override;
  }

  // Subagent contexts default to low (cheaper, faster)
  if (options.isSubagent) return 'low';

  if (!userMessage || typeof userMessage !== 'string') return 'high';

  const text = userMessage;

  // Check max patterns first (debugging takes priority)
  for (const pattern of MAX_EFFORT_PATTERNS) {
    if (pattern.test(text)) return 'max';
  }

  // Check low patterns
  for (const pattern of LOW_EFFORT_PATTERNS) {
    if (pattern.test(text)) return 'low';
  }

  // Default
  return 'high';
}

/**
 * Map effort tier to API parameter values for different providers.
 *
 * @param {'low'|'high'|'max'} tier
 * @param {string} [provider='anthropic']
 * @returns {object} Provider-specific effort parameters
 */
function effortToParams(tier, provider = 'anthropic') {
  switch (provider) {
    case 'anthropic':
    case 'claude':
      // Claude: thinking budget.
      // NOTE: camelCase `budgetTokens` — both consumers (claudeAdapter.js,
      // multiFreeService.js) read `options.thinking.budgetTokens`. Emitting
      // snake_case here silently dropped the budget (fell back to a flat
      // 10000), neutering the per-effort / thinkingFloor tiers.
      return {
        low:  { thinking: { budgetTokens: 1024 } },
        high: { thinking: { budgetTokens: 8192 } },
        max:  { thinking: { budgetTokens: 32768 } },
      }[tier] || {};

    case 'deepseek':
      // DeepSeek: reasoning_effort parameter
      return { reasoning_effort: tier };

    case 'openai':
      // OpenAI: reasoning_effort
      return { reasoning_effort: tier === 'max' ? 'high' : tier };

    default:
      return {};
  }
}

module.exports = {
  resolveEffort,
  effortToParams,
};
