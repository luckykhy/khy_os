'use strict';

// 图像占位符由单一真源 plainTextImageDegrade 提供（纯叶子，零依赖，单向引用安全）。
// guarded require：模块缺失时降级为最简占位，绝不让 content 提取因此抛错。
let _describeImagePlaceholder;
try {
  _describeImagePlaceholder = require('./gateway/plainTextImageDegrade').describeImagePlaceholder;
} catch {
  _describeImagePlaceholder = () => '[image]';
}


/**
 * contentBlockUtils.js — Anthropic content block 格式辅助工具。
 *
 * 在 KHY 消息管线中，content 字段有两种形态：
 * - string: 纯文本（传统格式，所有适配器都支持）
 * - Array<ContentBlock>: Anthropic 结构化 content blocks（原生适配器支持）
 *
 * 本模块提供统一的类型判断、转换和构建函数，
 * 隔离 string/Array 分支逻辑，避免各模块重复判断。
 */

/**
 * 从 content（string 或 Array<ContentBlock>）中提取纯文本。
 * @param {string|Array|undefined|null} content
 * @returns {string}
 */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    } else if (block.type === 'image' || block.type === 'image_url') {
      // 图像块降级为占位符，绝不静默丢弃——否则纯文本模型既看不到图、
      // 也不知道用户发过图。占位符由单一真源生成（plainTextImageDegrade）。
      texts.push(_describeImagePlaceholder(block));
    } else if (block.type === 'tool_use') {
      // tool_use block 不产生用户可见文本，跳过
    } else if (block.type === 'tool_result') {
      // tool_result 的 content 可能是 string 或嵌套 blocks
      if (typeof block.content === 'string') {
        texts.push(block.content);
      } else if (Array.isArray(block.content)) {
        texts.push(contentToText(block.content));
      }
    } else if (block.type === 'thinking' && block.thinking) {
      // thinking block 不加入文本提取
    }
  }
  return texts.join('\n');
}

/**
 * 判断 content 是否为结构化 content blocks 数组。
 * @param {*} content
 * @returns {boolean}
 */
function isStructuredContent(content) {
  return Array.isArray(content) && content.length > 0
    && content[0] != null && typeof content[0] === 'object' && 'type' in content[0];
}

/**
 * 构建 assistant 消息的 content。
 * - 无 toolUseBlocks 且无 thinkingBlocks 时返回纯文本字符串（零变化，向后兼容）
 * - 否则返回 Anthropic content blocks 数组
 *
 * Anthropic 规范：扩展思维开启且后续轮要回传时，thinking/redacted_thinking
 * 块必须作为 assistant 轮的**首块**（先于 text/tool_use），并携带原始 signature。
 * 仅当 thinkingBlocks 实际存在时才 prepend → 非思维路径逐字节不变（零回归）。
 *
 * @param {string} text - 助手回复文本
 * @param {Array|undefined} toolUseBlocks - 工具调用 blocks（含 id, name, input）
 * @param {Array|undefined} [thinkingBlocks] - 结构化思维 blocks（thinking+signature / redacted_thinking+data）
 * @returns {string|Array}
 */
function buildAssistantContent(text, toolUseBlocks, thinkingBlocks) {
  const hasThinking = Array.isArray(thinkingBlocks) && thinkingBlocks.length > 0;
  const hasToolUse = Array.isArray(toolUseBlocks) && toolUseBlocks.length > 0;
  if (!hasToolUse && !hasThinking) {
    return text || '';
  }

  const blocks = [];
  // Thinking blocks must precede text/tool_use per Anthropic extended-thinking rules.
  if (hasThinking) {
    for (const tb of thinkingBlocks) {
      if (!tb || typeof tb !== 'object') continue;
      if (tb.type === 'thinking' && tb.signature) {
        blocks.push({ type: 'thinking', thinking: tb.thinking || '', signature: tb.signature });
      } else if (tb.type === 'redacted_thinking' && tb.data) {
        blocks.push({ type: 'redacted_thinking', data: tb.data });
      }
    }
  }
  if (text) {
    blocks.push({ type: 'text', text });
  }
  if (hasToolUse) {
    for (const b of toolUseBlocks) {
      if (!b || !b.id || !b.name) continue;
      blocks.push({
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: b.input || {},
      });
    }
  }
  return blocks.length > 0 ? blocks : (text || '');
}

/**
 * Resolve tool_result content, preferring structured content blocks when available.
 * Anthropic API accepts both string and [{type:"text",...}] array for tool_result.content.
 *
 * @param {Array|undefined} contentBlocks - Structured Anthropic content blocks (_contentBlocks)
 * @param {string|*} contentFallback - Plain text fallback (content field)
 * @returns {string|Array} Resolved content for tool_result block
 */
function _resolveToolResultContent(contentBlocks, contentFallback) {
  // Prefer structured content blocks (e.g. image blocks) when available
  if (Array.isArray(contentBlocks) && contentBlocks.length > 0
      && contentBlocks[0] && typeof contentBlocks[0] === 'object' && 'type' in contentBlocks[0]) {
    return contentBlocks;
  }
  // String content passes through (Anthropic accepts string in tool_result.content)
  if (typeof contentFallback === 'string') return contentFallback;
  // Fallback: stringify
  return JSON.stringify(contentFallback || '');
}

/**
 * 构建 tool_result content blocks 数组（Anthropic 规范：承载于 role='user' 消息中）。
 *
 * 支持 _contentBlocks 透传：当工具返回图片等结构化内容时，
 * _contentBlocks 携带原生 Anthropic content block 数组，优先于 content 字符串。
 *
 * @param {Array<{tool_use_id: string, content: string, _contentBlocks?: Array, is_error?: boolean}>} results
 * @returns {Array|null} content blocks 数组，无有效结果时返回 null
 */
function buildToolResultContent(results) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const blocks = [];
  for (const r of results) {
    if (!r || !r.tool_use_id) continue;
    blocks.push({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content: _resolveToolResultContent(r._contentBlocks, r.content),
      ...(r.is_error ? { is_error: true } : {}),
    });
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * 将 content（string 或 Array）强制降级为纯文本字符串。
 * 与 contentToText 功能相同，语义上强调"降级"——用于不支持 blocks 的适配器。
 *
 * @param {string|Array} content
 * @returns {string}
 */
function flattenContent(content) {
  return contentToText(content);
}

/**
 * Ensure every tool_use block in assistant messages has a matching tool_result
 * in the following user message. If missing, inject a synthetic placeholder
 * tool_result instead of degrading the assistant message to plain text.
 *
 * Inspired by Claude Code's ensureToolResultPairing().
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 * @returns {Array<{role: string, content: string|Array}>} — mutated in place and returned
 */
function ensureToolResultPairing(messages) {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    // Collect tool_use IDs from this assistant message
    const toolUseIds = [];
    for (const block of msg.content) {
      if (block && block.type === 'tool_use' && block.id) {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    // Find matched tool_result IDs in the next user message
    const next = messages[i + 1];
    const resultIds = new Set();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (block && block.type === 'tool_result' && block.tool_use_id) {
          resultIds.add(block.tool_use_id);
        }
      }
    }

    // Find missing IDs
    const missingIds = toolUseIds.filter(id => !resultIds.has(id));
    if (missingIds.length === 0) continue;

    // Inject synthetic tool_result placeholders for missing IDs.
    // is_error MUST stay false: an earlier tool_result was dropped to reclaim
    // context space, NOT because the tool failed. Marking it is_error:true made
    // models treat the call as failed and re-run the exact same tool (the
    // observed "反复重搜同一查询" symptom). The text explicitly says the result
    // existed and can be re-fetched only if still needed.
    const placeholders = missingIds.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: '[Earlier tool result omitted to save context. It completed successfully; re-run the tool only if you still need its output.]',
      is_error: false,
    }));

    if (next && next.role === 'user' && Array.isArray(next.content)) {
      // Append placeholders to existing structured user message
      next.content = [...next.content, ...placeholders];
    } else if (next && next.role === 'user') {
      // Convert plain text user message to structured with text + placeholders
      next.content = [
        { type: 'text', text: typeof next.content === 'string' ? next.content : String(next.content || '') },
        ...placeholders,
      ];
    } else {
      // No user message follows — insert one with just placeholders
      messages.splice(i + 1, 0, { role: 'user', content: placeholders });
    }
  }
  return messages;
}

module.exports = {
  contentToText,
  isStructuredContent,
  buildAssistantContent,
  buildToolResultContent,
  flattenContent,
  ensureToolResultPairing,
};
