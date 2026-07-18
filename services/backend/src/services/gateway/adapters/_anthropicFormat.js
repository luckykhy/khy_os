/**
 * _anthropicFormat.js — Anthropic 消息格式解析与转换的共享工具
 *
 * 从 kiroAdapter.js 提取，供 kiro/trae/relay 等多适配器复用。
 * 提供：
 * - extractAnthropicText / ToolUses / ToolResults / Images
 * - convertAnthropicTools（Anthropic → CodeWhisperer toolSpecification）
 */
'use strict';
const { anthropicToCW: _sharedAnthropicToCW } = require('./_toolSchemaConverter');

/**
 * 从 Anthropic content blocks 提取纯文本。
 * @param {string|Array} content
 * @returns {string}
 */
function extractAnthropicText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('');
}

/**
 * 提取 tool_use blocks，转为 { toolUseId, name, input } 格式。
 * @param {Array} content
 * @returns {Array<{toolUseId: string, name: string, input: object}>}
 */
function extractAnthropicToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ toolUseId: b.id, name: b.name, input: b.input || {} }));
}

/**
 * 提取 tool_result blocks，转为 CodeWhisperer toolResults 格式。
 * @param {Array} content
 * @returns {Array<{toolUseId: string, content: Array, status: string}>}
 */
function extractAnthropicToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_result')
    .map(b => {
      let resultContent;
      if (typeof b.content === 'string') {
        resultContent = [{ text: b.content }];
      } else if (Array.isArray(b.content)) {
        resultContent = b.content.map(c => {
          if (typeof c === 'string') return { text: c };
          if (c.type === 'text') return { text: c.text };
          return { text: JSON.stringify(c) };
        });
      } else {
        resultContent = [{ text: '' }];
      }
      return {
        toolUseId: b.tool_use_id,
        content: resultContent,
        status: b.is_error ? 'error' : 'success',
      };
    });
}

/**
 * 从 Anthropic content blocks 提取图片，转为 CodeWhisperer 格式。
 * 支持 Anthropic base64、data URL、OpenAI vision 三种格式。
 * @param {Array} content
 * @returns {Array<{format: string, source: {bytes: Buffer}}>}
 */
function extractAnthropicImages(content) {
  if (!Array.isArray(content)) return [];
  const formatMap = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const images = [];
  for (const block of content) {
    if (block.type === 'image' && block.source) {
      if (block.source.type === 'base64' && block.source.data) {
        const format = formatMap[block.source.media_type] || 'jpeg';
        images.push({ format, source: { bytes: Buffer.from(block.source.data, 'base64') } });
      } else if (block.source.type === 'url' && block.source.url?.startsWith('data:')) {
        const parts = block.source.url.split(',');
        if (parts.length >= 2) {
          const mimeMatch = parts[0].match(/data:(image\/\w+)/);
          const format = mimeMatch ? (formatMap[mimeMatch[1]] || 'jpeg') : 'jpeg';
          images.push({ format, source: { bytes: Buffer.from(parts[1], 'base64') } });
        }
      }
    }
    // OpenAI vision 格式兼容
    if (block.type === 'image_url' && block.image_url) {
      const url = typeof block.image_url === 'string' ? block.image_url : block.image_url.url;
      if (url?.startsWith('data:')) {
        const parts = url.split(',');
        if (parts.length >= 2) {
          const mimeMatch = parts[0].match(/data:(image\/\w+)/);
          const format = mimeMatch ? (formatMap[mimeMatch[1]] || 'jpeg') : 'jpeg';
          images.push({ format, source: { bytes: Buffer.from(parts[1], 'base64') } });
        }
      }
    }
  }
  return images;
}

// convertAnthropicTools replaced by shared _toolSchemaConverter (Phase 5A)
function convertAnthropicTools(tools) {
  return _sharedAnthropicToCW(tools);
}

module.exports = {
  extractAnthropicText,
  extractAnthropicToolUses,
  extractAnthropicToolResults,
  extractAnthropicImages,
  convertAnthropicTools,
};
