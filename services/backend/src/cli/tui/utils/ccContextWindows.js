'use strict';

/**
 * ccContextWindows.js —— 模型上下文窗口大小（tokens）
 *
 * 用于状态栏 Context 百分比计算。
 * 支持 OpenAI 和 Anthropic 双家族。
 *
 * 参考：[DESIGN-ARCH-081] OpenAI 模型上下文窗口
 */

const MODEL_CONTEXT_WINDOWS = Object.freeze({
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_384,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,

  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
});

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 获取模型的上下文窗口大小
 * @param {string} modelId
 * @returns {number} token 数
 */
function getContextWindow(modelId) {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;

  // 精确匹配
  if (MODEL_CONTEXT_WINDOWS[modelId]) {
    return MODEL_CONTEXT_WINDOWS[modelId];
  }

  // 前缀匹配
  if (modelId.startsWith('gpt-4o')) return 128_000;
  if (modelId.startsWith('gpt-4')) return 8_192;
  if (modelId.startsWith('gpt-3.5')) return 16_384;
  if (modelId.startsWith('o1-')) return 128_000;
  if (modelId.startsWith('o3-')) return 200_000;
  if (modelId.startsWith('claude-')) return 200_000;

  return DEFAULT_CONTEXT_WINDOW;
}

module.exports = { MODEL_CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, getContextWindow };
