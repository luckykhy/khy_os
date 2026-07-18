'use strict';

/**
 * Codebase Intent Classifier — lightweight heuristic classifier that determines
 * if a user message is a codebase question, enabling automatic pre-fetch of
 * relevant files before the main model response.
 *
 * Returns { isCodebase: boolean, type: string } where type is:
 *   'file_reference' — explicit file path or extension mention
 *   'code_search'    — looking for function/class/variable definitions
 *   'structural'     — architecture/design/flow questions
 *   'none'           — not a codebase query
 */

/**
 * Classify whether a user message is a codebase-related query.
 * @param {string} message - Raw user message text
 * @returns {{ isCodebase: boolean, type: string }}
 */
function isCodebaseQuery(message) {
  const text = String(message || '').trim();
  if (text.length < 3) return { isCodebase: false, type: 'none' };
  const lower = text.toLowerCase();

  // Pattern 1: Explicit file path or extension references
  // Matches: "server.js", "src/utils/helper.ts", "*.vue files"
  if (/(?:^|\s)[\w./\\-]+\.\w{1,6}(?:\s|$)/m.test(text)) {
    return { isCodebase: true, type: 'file_reference' };
  }

  // Pattern 2: Code search — looking for definitions/implementations
  if (/where is|find\s+(the\s+)?function|find\s+(the\s+)?class|show me.*(?:code|implementation|definition)|what does.*(?:function|method|class)\b/i.test(text)) {
    return { isCodebase: true, type: 'code_search' };
  }
  // Chinese code search patterns
  if (/哪个文件|在哪里|怎么实现|代码在哪|函数.*在哪|在哪.*定义|找到.*函数|找.*实现/u.test(text)) {
    return { isCodebase: true, type: 'code_search' };
  }

  // Pattern 3: Architecture/structure questions
  if (/\b(architecture|structure|how\s+(is|does|do)\s+\w+\s+(implement|work)|code\s*base|project\s+structure)\b/i.test(text)) {
    return { isCodebase: true, type: 'structural' };
  }
  // Chinese structural patterns
  if (/架构|设计|代码结构|项目结构|怎么工作|实现原理|调用链|调用流程/u.test(text)) {
    return { isCodebase: true, type: 'structural' };
  }

  // Pattern 4: Explicit code identifiers with camelCase/snake_case
  // e.g. "handleLogin", "tool_use_loop", "AgentContext"
  const hasCodeIdentifier = /\b[a-z]+[A-Z]\w+\b/.test(text) || /\b[a-z]+_[a-z]+\w*\b/.test(text);
  if (hasCodeIdentifier && /\b(what|how|where|explain|分析|解释|看看)\b/i.test(lower)) {
    return { isCodebase: true, type: 'code_search' };
  }

  return { isCodebase: false, type: 'none' };
}

module.exports = { isCodebaseQuery };
