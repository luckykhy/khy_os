'use strict';

/**
 * _responsesFormat.js — Shared parsers for the OpenAI Responses API
 * (`/v1/responses`, internally the "codex" wire format) non-streaming `output[]`.
 *
 * Extracted from codexAdapter.js so the outbound `responses` protocol handler
 * (_protocolPipeline) and codexAdapter's own direct path share one source of
 * truth for turning a Responses `output[]` array into text / function-call /
 * reasoning parts.
 *
 * Pure functions, no I/O. The shapes mirror the Responses API:
 *   - message items:      { type:'message', role:'assistant', content:[{type:'output_text', text}] }
 *   - function_call items:{ type:'function_call', call_id:'call_…', name, arguments:'<json string>' }
 *   - reasoning items:    { type:'reasoning', summary:[{type:'summary_text', text}] }  (or .text/.content)
 */

/**
 * Pull display text out of a Responses message item (or any content-bearing item).
 * @param {object} item
 * @returns {string}
 */
function extractMessageText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text.trim();
  if (typeof item.message === 'string' && item.message.trim()) return item.message.trim();

  const pullFromContent = (content) => {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const blk of content) {
      if (!blk) continue;
      if (typeof blk === 'string') {
        parts.push(blk);
        continue;
      }
      if (typeof blk.text === 'string' && blk.text.trim()) {
        parts.push(blk.text.trim());
      }
    }
    return parts.join('\n').trim();
  };

  const fromContent = pullFromContent(item.content);
  if (fromContent) return fromContent;
  const fromMsgContent = pullFromContent(item.message?.content);
  if (fromMsgContent) return fromMsgContent;
  const fromResultContent = pullFromContent(item.result?.content);
  if (fromResultContent) return fromResultContent;
  return '';
}

/**
 * Extract <thinking>…</thinking> blocks from prompt-style text content.
 * @param {string} text
 * @returns {{ thinking: string|null, rest: string }}
 */
function extractThinkingTags(text) {
  if (!text || typeof text !== 'string') return { thinking: null, rest: text || '' };
  const thinkingParts = [];
  const rest = text.replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_, content) => {
    const trimmed = content.trim();
    if (trimmed) thinkingParts.push(trimmed);
    return '';
  }).trim();
  return {
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n') : null,
    rest,
  };
}

/**
 * Extract text from a native Responses reasoning item.
 * @param {object} item
 * @returns {string}
 */
function extractReasoningText(item) {
  if (!item) return '';
  // Reasoning items can have: .summary (array of {type:'summary_text',text}), .text, or .content
  if (Array.isArray(item.summary)) {
    return item.summary
      .map(s => (typeof s === 'string' ? s : (s && s.text) || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map(c => (typeof c === 'string' ? c : (c && c.text) || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Parse a Responses API `output[]` array into text parts, function calls, and
 * reasoning parts.
 * @param {Array} output - the Responses `output[]` array
 * @returns {{ textParts: string[], functionCalls: Array<{call_id, name, arguments}>, reasoningParts: string[] }}
 */
function parseDirectResponse(output) {
  const textParts = [];
  const functionCalls = [];
  const reasoningParts = [];
  for (const item of (output || [])) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && (item.role === 'assistant' || !item.role)) {
      const text = extractMessageText(item);
      if (text) {
        // Extract prompt-based <thinking> tags from text content
        const { thinking, rest } = extractThinkingTags(text);
        if (thinking) reasoningParts.push(thinking);
        if (rest) textParts.push(rest);
      }
    } else if (item.type === 'function_call') {
      functionCalls.push({
        call_id: item.call_id || item.id || `fc_${Date.now()}_${functionCalls.length}`,
        name: item.name || 'unknown',
        arguments: item.arguments || '{}',
      });
    } else if (item.type === 'reasoning' || (item.type && String(item.type).includes('reasoning'))) {
      // OpenAI Responses API native reasoning items
      const text = extractReasoningText(item);
      if (text) reasoningParts.push(text);
    }
  }
  return { textParts, functionCalls, reasoningParts };
}

module.exports = {
  extractMessageText,
  extractThinkingTags,
  extractReasoningText,
  parseDirectResponse,
};
