'use strict';

/**
 * ccPricing.js —— OpenAI 模型定价 + 费用计算
 *
 * 定价单位：USD per 1M tokens
 *
 * 参考：[DESIGN-ARCH-081] OpenAI 费用计算
 */

const OPENAI_PRICING = Object.freeze({
  'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  'gpt-4-turbo': { input: 10.00, output: 30.00, cachedInput: 2.50 },
  'o1-preview': { input: 15.00, output: 60.00, cachedInput: 7.50 },
  'o1-mini': { input: 3.00, output: 12.00, cachedInput: 1.50 },
  'o3-mini': { input: 1.10, output: 4.40, cachedInput: 0.55 },
});

/**
 * 计算 OpenAI 模型调用费用
 * @param {string} modelId
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {number} cachedTokens
 * @returns {number} USD
 */
function calculateCost(modelId, inputTokens, outputTokens, cachedTokens = 0) {
  const pricing = OPENAI_PRICING[modelId] || OPENAI_PRICING['gpt-4o'];
  const inputCost = ((inputTokens - cachedTokens) * pricing.input) / 1_000_000;
  const cachedCost = (cachedTokens * pricing.cachedInput) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  return inputCost + cachedCost + outputCost;
}

module.exports = { OPENAI_PRICING, calculateCost };
