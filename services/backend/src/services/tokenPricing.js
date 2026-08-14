'use strict';

/**
 * tokenPricing — 纯定价/换算数学叶子(零 I/O、零可变状态、确定性、可单测)。
 *
 * 提取来源:services/tokenUsageService.js(Batch 3「接口恒等」公理化重构)。
 * 提取物:TOKEN_PRICING/USD_TO_CNY 常量表、calculateCost、estimateCost、
 * sumRecordsCost(getSessionCost 的求和内核)、estimateTokens。壳(tokenUsageService)
 * 以原签名薄委托本叶子,消费方(cli/router、routerDispatchOps、replSession、
 * useQueryBridge、aiChatCore、gateway/customerQuotaEnforcer 等)行为逐字段恒等。
 *
 * 契约:
 * - 所有函数输入相同则输出必相同;不读写模块级可变状态、不做 fs/网络 I/O、不读时钟。
 * - 价格表(pricingTable)与汇率(usdToCny)一律作参数注入,缺省取本模块内置常量
 *   (与提取前字面量逐字节一致)。读取外部价格配置(如 ai_gateway_pricing.json)
 *   属 I/O,永远留给调用方;本叶子绝不自行加载。
 * - 提取前的数值语义原样保留:provider 查表用 `table[provider] || table.default`
 *   (含原型链命中等历史行为)、负数/非数字 token 直接参与算式(NaN/负值原样传播)、
 *   不做四舍五入 —— 舍入/展示精度是壳与渲染层的职责。
 * - 仅当调用方注入畸形价格表(无 default 项)时,回退零价 {input:0, output:0};
 *   缺省表恒有 default,故壳路径不可能触达该分支(行为恒等)。
 *
 * 刻意不提取清单(均与 I/O 或可变状态耦合,留在 tokenUsageService):
 * - loadUsageData/saveUsageData/_usageFile/_legacyUsageFile:fs 读写与路径解析。
 * - recordUsage/getSessionUsage/resetUsage/_sessionUsage:会话级可变累加器。
 * - recordCodeChange/getCodeChanges/_codeChanges:会话代码改动账本(可变状态)。
 * - recordCompressionSavings/getCompressionStats/_compressionStats:可变状态。
 * - todayKey/monthKey/getUsageHistory:读系统时钟(非确定性)。
 * - getTodayUsage/getMonthUsage/getRemainingQuota:磁盘读取 + subscriptionService 运行时依赖。
 * - formatInlineSummary/formatUsageReport/formatCostReport/_fmtTokenCount:
 *   chalk/env 门控/动态 require,属渲染壳而非定价数学。
 * - getSessionCost 的「读 _sessionUsage.records」外壳:状态读取留壳,求和内核下沉为
 *   sumRecordsCost(records 由壳注入)。
 */

// USD to CNY exchange rate (approximate, updated periodically)
const USD_TO_CNY = 7.25;

// Per-token pricing by provider (USD per 1M tokens)
const TOKEN_PRICING = {
  OpenAI: { input: 0.15, output: 0.6 }, // gpt-4o-mini
  Anthropic: { input: 3.0, output: 15.0 }, // claude-3-5-sonnet
  'Google Gemini': { input: 0.075, output: 0.3 }, // gemini-2.5-flash
  Groq: { input: 0.05, output: 0.08 }, // llama-3.3
  OpenRouter: { input: 0.1, output: 0.3 }, // varies
  DeepSeek: { input: 0.27, output: 1.1 }, // deepseek-chat (cache miss)
  'Together AI': { input: 0.88, output: 0.88 }, // Llama-3.3-70B-Turbo
  智谱AI: { input: 0.1, output: 0.1 }, // glm-4
  讯飞星火: { input: 0.0, output: 0.0 }, // free tier
  百度文心: { input: 0.12, output: 0.12 }, // ERNIE
  通义千问: { input: 0.008, output: 0.02 }, // qwen-turbo
  HuggingFace: { input: 0.0, output: 0.0 }, // free inference
  Ollama: { input: 0.0, output: 0.0 }, // local
  default: { input: 0.1, output: 0.3 },
};

// Zero-price fallback, only reachable when the caller injects a malformed
// table without a 'default' entry (the built-in table always has one).
const _ZERO_PRICING = { input: 0, output: 0 };

/**
 * Resolve a provider's pricing entry from a table.
 * Lookup semantics mirror the pre-extraction code exactly:
 * `table[provider] || table['default']` (truthy-first, prototype hits included).
 * @param {string} provider
 * @param {object} [pricingTable=TOKEN_PRICING]
 * @returns {{ input: number, output: number }}
 */
function resolveProviderPricing(provider, pricingTable = TOKEN_PRICING) {
  const table = pricingTable && typeof pricingTable === 'object' ? pricingTable : TOKEN_PRICING;
  return table[provider] || table['default'] || _ZERO_PRICING;
}

/**
 * Calculate cost for a request based on provider pricing.
 * Pure math: (inputTokens * input + outputTokens * output) / 1e6, no rounding.
 * @param {string} provider
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {object} [pricingTable=TOKEN_PRICING]
 * @param {number} [usdToCny=USD_TO_CNY]
 * @returns {{ costUSD: number, costCNY: number }}
 */
function calculateCost(
  provider,
  inputTokens,
  outputTokens,
  pricingTable = TOKEN_PRICING,
  usdToCny = USD_TO_CNY
) {
  const pricing = resolveProviderPricing(provider, pricingTable);
  const costUSD = (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
  const costCNY = costUSD * usdToCny;
  return { costUSD, costCNY };
}

/**
 * Convenience: estimate cost from model/provider name + token counts.
 * Tries a case-insensitive substring match against table keys (insertion
 * order, first hit wins — identical to the pre-extraction loop), then default.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelOrProvider - model name or provider key
 * @param {object} [pricingTable=TOKEN_PRICING]
 * @returns {number} costUSD
 */
function estimateCost(inputTokens, outputTokens, modelOrProvider, pricingTable = TOKEN_PRICING) {
  const table = pricingTable && typeof pricingTable === 'object' ? pricingTable : TOKEN_PRICING;
  const key = String(modelOrProvider || '').toLowerCase();
  // Try to match a pricing key by substring
  let pricing = table['default'] || _ZERO_PRICING;
  for (const [name, p] of Object.entries(table)) {
    if (name !== 'default' && key.includes(name.toLowerCase())) {
      pricing = p;
      break;
    }
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
}

/**
 * Sum total cost over per-request usage records (getSessionCost's math core).
 * Accumulation order and per-record formula match the pre-extraction loop.
 * @param {Array<{provider?:string,inputTokens?:number,outputTokens?:number}>} records
 * @param {object} [pricingTable=TOKEN_PRICING]
 * @param {number} [usdToCny=USD_TO_CNY]
 * @returns {{ costUSD: number, costCNY: number }}
 */
function sumRecordsCost(records, pricingTable = TOKEN_PRICING, usdToCny = USD_TO_CNY) {
  let totalUSD = 0;
  const list = Array.isArray(records) ? records : [];
  for (const rec of list) {
    const pricing = resolveProviderPricing(rec && rec.provider, pricingTable);
    totalUSD += (rec.inputTokens * pricing.input + rec.outputTokens * pricing.output) / 1000000;
  }
  return { costUSD: totalUSD, costCNY: totalUSD * usdToCny };
}

/**
 * Estimate token count from text (fallback when API doesn't return usage).
 * Rough heuristic: ~4 chars per token for English, ~2 chars per token for Chinese.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  // NOTE(batch-3): intentionally NOT delegated to utils/simpleTokenEstimate — this is
  // a CJK-aware mixed-divisor formula (a SINGLE ceil over cjk/1.5 + nonCjk/4), which
  // is not decomposable into the chars/4 atom without changing outputs (ceil of a sum
  // is not the sum of ceils).
  // Count Chinese characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjkLen = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.5 + nonCjkLen / 4);
}

module.exports = {
  TOKEN_PRICING,
  USD_TO_CNY,
  resolveProviderPricing,
  calculateCost,
  estimateCost,
  sumRecordsCost,
  estimateTokens,
};
