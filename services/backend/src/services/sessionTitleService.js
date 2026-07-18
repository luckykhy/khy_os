'use strict';

/**
 * Session Title Service — auto-generate human-readable titles for conversations.
 *
 * Analyzes the first user message and/or the assistant reply to produce a
 * short, descriptive title (≤50 chars). Falls back to keyword extraction
 * when AI summarization is not available.
 *
 * @module sessionTitleService
 */

const log = require('../utils/logger');

// ── Keyword-based title generation (no AI needed) ──

/**
 * Extract a title from the first user message using heuristics.
 * @param {string} userMessage - The first user prompt
 * @param {string} [assistantReply] - The first assistant response
 * @returns {string} A short title (≤50 chars)
 */
function generateTitle(userMessage, assistantReply) {
  if (!userMessage || typeof userMessage !== 'string') return 'New Conversation';

  const text = userMessage.trim();

  // 1. If it's short enough, use it directly (cleaned up)
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length <= 50 && firstLine.length >= 3) {
    return _cleanTitle(firstLine);
  }

  // 2. Try extracting from common patterns
  const patternTitle = _extractFromPatterns(text);
  if (patternTitle) return patternTitle;

  // 3. Try keyword extraction
  const keywordTitle = _extractKeywords(text);
  if (keywordTitle) return keywordTitle;

  // 4. Truncate first line
  return _cleanTitle(firstLine.substring(0, 47) + '...');
}

/**
 * Generate a title using AI summarization.
 * @param {string} userMessage
 * @param {string} assistantReply
 * @param {object} aiModule - AI gateway for summarization
 * @returns {Promise<string>}
 */
async function generateTitleAI(userMessage, assistantReply, aiModule) {
  try {
    const prompt = `Generate a very short title (max 6 words) for this conversation. Reply with ONLY the title, nothing else.

User: ${userMessage.substring(0, 500)}
${assistantReply ? `Assistant: ${assistantReply.substring(0, 300)}` : ''}`;

    const gw = aiModule.gateway || aiModule;
    let result;

    if (typeof gw.query === 'function') {
      result = await gw.query(prompt, { maxTokens: 20, temperature: 0.3 });
    } else if (typeof gw.chat === 'function') {
      const resp = await gw.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 20,
        temperature: 0.3,
      });
      result = resp.content || resp.text;
    }

    if (result && typeof result === 'string') {
      const clean = result.trim().replace(/^["'`]|["'`]$/g, '').trim();
      if (clean.length >= 3 && clean.length <= 60) return clean;
    }
  } catch (err) {
    log.debug('AI title generation failed, using heuristic:', err.message);
  }

  // Fallback to heuristic
  return generateTitle(userMessage, assistantReply);
}

// ── Pattern Extractors ──

const TITLE_PATTERNS = [
  // "Fix the bug in ..."
  { regex: /^(fix|debug|solve|resolve)\s+(.{5,45})/i, group: 0 },
  // "Add/Implement/Create ..."
  { regex: /^(add|implement|create|build|write|make)\s+(.{5,45})/i, group: 0 },
  // "How to ..."
  { regex: /^(how\s+to|how\s+do\s+I)\s+(.{5,40})/i, group: 0 },
  // "Explain/What is ..."
  { regex: /^(explain|what\s+is|what\s+are|describe)\s+(.{5,40})/i, group: 0 },
  // "Update/Refactor/Optimize ..."
  { regex: /^(update|refactor|optimize|improve|enhance)\s+(.{5,40})/i, group: 0 },
  // "Remove/Delete ..."
  { regex: /^(remove|delete|drop|clean\s+up)\s+(.{5,40})/i, group: 0 },
  // "Test/Review ..."
  { regex: /^(test|review|check|verify|validate)\s+(.{5,40})/i, group: 0 },
  // Chinese patterns
  { regex: /^(修复|添加|实现|创建|解释|优化|更新|删除|测试|检查)\s*(.{2,30})/u, group: 0 },
];

function _extractFromPatterns(text) {
  for (const p of TITLE_PATTERNS) {
    const m = text.match(p.regex);
    if (m) {
      const title = m[p.group].trim();
      if (title.length <= 50) return _cleanTitle(title);
      return _cleanTitle(title.substring(0, 47) + '...');
    }
  }
  return null;
}

// ── Keyword Extraction ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'no', 'so', 'if', 'then', 'than', 'that', 'this', 'it', 'its',
  'i', 'me', 'my', 'we', 'you', 'your', 'he', 'she', 'they', 'them',
  'please', 'just', 'also', 'very', 'really', 'quite', 'well', 'much',
]);

function _extractKeywords(text) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (words.length === 0) return null;

  // Take first 5 meaningful words
  const keywords = words.slice(0, 5);
  const title = keywords.join(' ');
  if (title.length > 50) return title.substring(0, 47) + '...';
  return _capitalizeFirst(title);
}

function _cleanTitle(str) {
  return str
    .replace(/\s+/g, ' ')
    .replace(/^[.!?,;:\s]+/, '')
    .replace(/[.!?,;:\s]+$/, '')
    .trim();
}

function _capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = {
  generateTitle,
  generateTitleAI,
  _extractFromPatterns,
  _extractKeywords,
};
