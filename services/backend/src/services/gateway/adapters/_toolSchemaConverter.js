'use strict';

/**
 * _toolSchemaConverter.js — Unified tool schema format conversion.
 *
 * Consolidates tool schema conversion logic scattered across adapters:
 *   - relayApiAdapter.convertToolsToOpenAI()
 *   - _anthropicFormat.convertAnthropicTools() (Anthropic → CodeWhisperer)
 *
 * Supports three protocol formats:
 *   - Anthropic: { name, description, input_schema }
 *   - OpenAI:    { type: 'function', function: { name, description, parameters } }
 *   - CW/Q:     { toolSpecification: { name, description, inputSchema: { json } } }
 *
 * Phase 3C of industrial-grade modularization.
 * Dependencies: none.
 */

const OPENAI_DESC_LIMIT = 4096;
const CW_DESC_LIMIT = 10000;

// Default tool names excluded from Anthropic→CW conversion when the caller
// passes no explicit `excludeNames`. Hoisted to a module constant so the
// hot path (every tool-carrying CW/Bedrock request) reuses one Set instead
// of allocating a fresh one per call. Consumed read-only (`.has`); never
// mutated, never returned — safe to share across requests.
const _DEFAULT_CW_EXCLUDE = new Set(['web_search', 'websearch']);

const { toOpenAIVisionBlocks } = require('./_imageCompat');

/**
 * Split a tool_result's content into a plain-text string and any embedded
 * image blocks. OpenAI's `role:'tool'` message only accepts string content,
 * so images are returned separately to be relayed as a follow-up vision
 * message rather than silently degraded to the literal '[Image]'.
 *
 * @param {string|Array|object} content - tool_result.content
 * @returns {{ text: string, images: Array }}
 */
function _splitToolResultContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: content == null ? '' : JSON.stringify(content), images: [] };
  }
  const textParts = [];
  const images = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') {
      if (typeof b === 'string') textParts.push(b);
      continue;
    }
    if (b.type === 'text') {
      textParts.push(b.text || '');
    } else if (b.type === 'image') {
      images.push(b);
    } else if (b.text) {
      textParts.push(b.text);
    }
  }
  return { text: textParts.join(''), images };
}

/**
 * Anthropic tool format → OpenAI function-calling format.
 *
 * @param {Array} tools - Array of { name, description, input_schema }
 * @param {object} [options]
 * @param {number} [options.descriptionLimit=4096] - Max description length
 * @returns {Array|undefined} OpenAI tools array or undefined if empty
 */
function anthropicToOpenAI(tools, { descriptionLimit = OPENAI_DESC_LIMIT } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, descriptionLimit),
      parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
    },
  }));
}

/**
 * OpenAI function-calling format → Anthropic tool format.
 *
 * @param {Array} tools - Array of { type: 'function', function: { name, description, parameters } }
 * @returns {Array|undefined} Anthropic tools array or undefined if empty
 */
function openAIToAnthropic(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  return tools
    .filter(t => t && (t.type === 'function' || t.function))
    .map(t => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    });
}

/**
 * Anthropic tool format → CodeWhisperer/Q Developer format.
 *
 * @param {Array} tools - Array of { name, description, input_schema }
 * @param {object} [options]
 * @param {number} [options.descriptionLimit=10000] - Max description length
 * @param {Set|Array} [options.excludeNames] - Tool names to exclude
 * @returns {Array|undefined} CW tools array or undefined if empty
 */
function anthropicToCW(tools, { descriptionLimit = CW_DESC_LIMIT, excludeNames = null } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const excludeSet = excludeNames
    ? (excludeNames instanceof Set ? excludeNames : new Set(excludeNames))
    : _DEFAULT_CW_EXCLUDE;

  const filtered = tools.filter(t => !excludeSet.has(t.name));
  if (filtered.length === 0) return undefined;

  return filtered.map(t => ({
    toolSpecification: {
      name: t.name,
      description: (t.description || '').slice(0, descriptionLimit),
      inputSchema: {
        json: t.input_schema || t.parameters || {},
      },
    },
  }));
}

/**
 * Extract tool_use blocks from an OpenAI response choice into
 * Anthropic tool_use format.
 *
 * @param {object} choice - OpenAI response choice with tool_calls
 * @returns {Array} Array of { type: 'tool_use', id, name, input }
 */
function openAIToolCallsToAnthropic(choice) {
  const toolCalls = choice?.message?.tool_calls || choice?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];

  return toolCalls
    .filter(tc => tc && tc.function)
    .map(tc => {
      let input = {};
      try {
        input = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function.arguments || {});
      } catch { /* keep empty */ }

      return {
        type: 'tool_use',
        id: tc.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.function.name,
        input,
      };
    });
}

/**
 * Convert Anthropic tool_use/tool_result messages to OpenAI format.
 * Used when relaying Anthropic-formatted conversations to OpenAI endpoints.
 *
 * @param {Array} messages - Anthropic-format messages
 * @param {boolean} hasTools - Whether tools are enabled
 * @returns {Array} OpenAI-format messages
 */
function convertMessagesAnthropicToOpenAI(messages, hasTools = true, opts = {}) {
  if (!Array.isArray(messages)) return messages;

  // opts.useToolRole: if false, embed tool results as role:'user' plain text
  // (for weak models that don't support role:'tool')
  const useToolRole = opts.useToolRole !== false;

  return messages.map(msg => {
    if (!msg || !Array.isArray(msg.content)) return msg;

    // Assistant message with tool_use blocks
    if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && hasTools) {
          if (useToolRole) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: typeof block.input === 'string'
                  ? block.input
                  : JSON.stringify(block.input || {}),
              },
            });
          } else {
            // Fallback: embed tool call as text for weak models
            textParts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input || {}).slice(0, 200)})]`);
          }
        }
      }

      const result = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length > 0) result.tool_calls = toolCalls;
      return result;
    }

    // User message with tool_result blocks
    if (msg.role === 'user') {
      const toolResults = [];
      const otherBlocks = [];

      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.push(block);
        } else {
          otherBlocks.push(block);
        }
      }

      if (toolResults.length === 0) return msg;

      if (!useToolRole) {
        // Fallback: embed tool results as role:'user' plain text
        const parts = [];
        for (const b of otherBlocks) {
          if (b.type === 'text' && b.text) parts.push(b.text);
        }
        for (const tr of toolResults) {
          const content = typeof tr.content === 'string'
            ? tr.content
            : (Array.isArray(tr.content)
              ? tr.content.map(b => {
                  if (b.type === 'text') return b.text || '';
                  if (b.type === 'image') return '[Image]';
                  return b.text || '';
                }).join('')
              : JSON.stringify(tr.content || ''));
          parts.push(`[Tool Result: ${tr.tool_use_id || 'unknown'}]\n${content}`);
        }
        return { role: 'user', content: parts.join('\n\n') };
      }

      // Each tool_result becomes a separate role:'tool' message. Embedded
      // images can't ride in role:'tool' string content, so they are relayed
      // as a follow-up role:'user' vision message (preserved, not '[Image]').
      const expanded = [];
      if (otherBlocks.length > 0) {
        expanded.push({ ...msg, content: otherBlocks });
      }
      const deferredImages = [];
      for (const tr of toolResults) {
        const { text, images } = _splitToolResultContent(tr.content);
        const content = typeof tr.content === 'string' ? tr.content : (text || '');
        expanded.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: images.length > 0 && !content ? '[see attached image below]' : content,
        });
        if (images.length > 0) deferredImages.push(...images);
      }
      if (deferredImages.length > 0) {
        const visionBlocks = toOpenAIVisionBlocks(deferredImages);
        if (visionBlocks.length > 0) {
          expanded.push({
            role: 'user',
            content: [{ type: 'text', text: 'Tool result image(s):' }, ...visionBlocks],
          });
        }
      }
      return expanded;
    }

    return msg;
  }).flat();
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropic,
  anthropicToCW,
  openAIToolCallsToAnthropic,
  convertMessagesAnthropicToOpenAI,
  _DEFAULT_CW_EXCLUDE,
};
