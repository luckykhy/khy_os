'use strict';

/**
 * usageFormatter.js — Tiered cost estimation and human-friendly formatting.
 *
 * Ported from OpenClaw's usage-format.ts.
 * Provides:
 *   - Token count formatting (1.2m / 42k / 999)
 *   - USD formatting with magnitude-adaptive precision
 *   - Tiered pricing lookup by [start, end) ranges
 *   - Cost estimation (flat + tiered)
 *   - Usage line formatting for display
 */

// ── Token Formatting ─────────────────────────────────────────────

/**
 * Format a token count for display.
 *   >=1M  → "2.5m"
 *   >=1K  → "1.2k" or "12k"
 *   <1K   → "999"
 *
 * @param {number} [value]
 * @returns {string}
 */
function formatTokenCount(value) {
  // 门控 KHY_USAGE_TOKEN_PROMOTION(默认开):修正边界正下方的舍入越界
  // (999500→"1.0m" 而非 "1000k"、9999→"10k" 而非 "10.0k")。门关/异常 → null → 落回下方 legacy。
  try {
    const shaped = require('./usageTokenCountShape').shapeTokenCount(value, process.env);
    if (shaped != null) return shaped;
  } catch { /* fail-soft → legacy */ }

  if (value == null || !Number.isFinite(value)) return '0';
  const v = Math.abs(value);

  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return `${m.toFixed(1)}m`;
  }
  if (v >= 1_000) {
    const k = v / 1_000;
    if (k >= 1_000) return `${(v / 1_000_000).toFixed(1)}m`; // 999,500+ rounds up
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return String(Math.round(v));
}

// ── USD Formatting ──────────────────────────────────────────────

/**
 * Format a USD amount with magnitude-adaptive precision.
 *   >= $0.01 → "$1.23" (2 decimals)
 *   <  $0.01 → "$0.0042" (4 decimals)
 *
 * @param {number} [value]
 * @returns {string|undefined}
 */
function formatUsd(value) {
  if (value == null || !Number.isFinite(value)) return undefined;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

// ── Tiered Pricing ──────────────────────────────────────────────

/**
 * @typedef {object} PricingTier
 * @property {number} input   - USD per million input tokens
 * @property {number} output  - USD per million output tokens
 * @property {number} cacheRead  - USD per million cache read tokens
 * @property {number} cacheWrite - USD per million cache write tokens
 * @property {[number, number]} range - Half-open [start, end) on input token axis
 */

/**
 * Normalize raw pricing tiers into sorted, validated array.
 *
 * @param {Array<{input: number, output: number, cacheRead?: number, cacheWrite?: number, range: number[]}>} raw
 * @returns {PricingTier[]|undefined}
 */
function normalizeTieredPricing(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const tiers = [];
  for (const t of raw) {
    if (!Number.isFinite(t.input) || !Number.isFinite(t.output)) continue;
    const start = Array.isArray(t.range) ? (t.range[0] || 0) : 0;
    let end = Array.isArray(t.range) && t.range.length > 1 ? t.range[1] : Infinity;
    if (end <= 0) end = Infinity;
    tiers.push({
      input: t.input,
      output: t.output,
      cacheRead: t.cacheRead || 0,
      cacheWrite: t.cacheWrite || 0,
      range: [start, end],
    });
  }

  if (tiers.length === 0) return undefined;
  tiers.sort((a, b) => a.range[0] - b.range[0]);
  return tiers;
}

/**
 * Select the applicable pricing tier for a given input token count.
 * Uses single-tier selection (not blended/stepped).
 *
 * @param {PricingTier[]} tiers
 * @param {number} inputTokens
 * @returns {PricingTier|undefined}
 */
function selectPricingTier(tiers, inputTokens) {
  if (!tiers || tiers.length === 0) return undefined;
  if (inputTokens <= 0) return tiers[0];

  for (const tier of tiers) {
    if (inputTokens >= tier.range[0] && inputTokens < tier.range[1]) {
      return tier;
    }
  }
  // Overflow: use last tier
  return tiers[tiers.length - 1];
}

// ── Cost Estimation ─────────────────────────────────────────────

/**
 * @typedef {object} ModelCostConfig
 * @property {number} input   - USD per million input tokens
 * @property {number} output  - USD per million output tokens
 * @property {number} [cacheRead]  - USD per million cache read tokens
 * @property {number} [cacheWrite] - USD per million cache write tokens
 * @property {PricingTier[]} [tieredPricing] - Overrides flat rates when present
 */

/**
 * Estimate the USD cost of a usage record.
 *
 * @param {object} params
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} params.usage
 * @param {ModelCostConfig} params.cost
 * @returns {number|undefined}
 */
function estimateUsageCost({ usage, cost }) {
  if (!usage || !cost) return undefined;

  const input = usage.input || 0;
  const output = usage.output || 0;
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;

  let total;
  if (cost.tieredPricing && cost.tieredPricing.length > 0) {
    const tier = selectPricingTier(cost.tieredPricing, input);
    if (!tier) return undefined;
    total = input * tier.input
          + output * tier.output
          + cacheRead * tier.cacheRead
          + cacheWrite * tier.cacheWrite;
  } else {
    total = input * (cost.input || 0)
          + output * (cost.output || 0)
          + cacheRead * (cost.cacheRead || 0)
          + cacheWrite * (cost.cacheWrite || 0);
  }

  const result = total / 1_000_000;
  return Number.isFinite(result) ? result : undefined;
}

// ── Default Model Pricing ───────────────────────────────────────

/**
 * Default pricing per million tokens (as of 2025).
 * Updated: claude-4 family, gpt-4.1, deepseek-r1, gemini-2.5.
 */
const DEFAULT_MODEL_PRICING = {
  // Anthropic
  'claude-opus-4':     { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4':   { input: 3.0,  output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-3.5':  { input: 0.8,  output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0 },
  // OpenAI
  'gpt-4.1':          { input: 2.0,  output: 8.0,  cacheRead: 0.5,  cacheWrite: 0 },
  'gpt-4.1-mini':     { input: 0.4,  output: 1.6,  cacheRead: 0.1,  cacheWrite: 0 },
  'gpt-4.1-nano':     { input: 0.1,  output: 0.4,  cacheRead: 0.025, cacheWrite: 0 },
  'o3':               { input: 2.0,  output: 8.0,  cacheRead: 0.5,  cacheWrite: 0 },
  'o3-mini':          { input: 1.1,  output: 4.4,  cacheRead: 0.275, cacheWrite: 0 },
  'o4-mini':          { input: 1.1,  output: 4.4,  cacheRead: 0.275, cacheWrite: 0 },
  // Google
  'gemini-2.5-pro':   { input: 1.25, output: 10.0, cacheRead: 0.315, cacheWrite: 0 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6,  cacheRead: 0.0375, cacheWrite: 0 },
  // DeepSeek
  'deepseek-r1':      { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 },
  'deepseek-v3':      { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0 },
  // Local / free
  'local':            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// Prefix-match lookup entries for DEFAULT_MODEL_PRICING, hoisted to a module
// constant so resolveModelCost() reuses one [key, config] array across usage
// lines instead of allocating a fresh Object.entries() per fallback lookup.
// The pricing table is module-const and never mutated, so this snapshot is
// permanently valid. Config objects are returned by reference (unchanged
// behavior); callers treat them as read-only.
const _MODEL_PRICING_ENTRIES = Object.entries(DEFAULT_MODEL_PRICING);

/**
 * Look up cost config for a model name.
 * Tries exact match, then prefix match.
 *
 * @param {string} model
 * @returns {ModelCostConfig|undefined}
 */
function resolveModelCost(model) {
  if (!model) return undefined;
  const lower = model.toLowerCase();

  // Exact match
  if (DEFAULT_MODEL_PRICING[lower]) return DEFAULT_MODEL_PRICING[lower];

  // Prefix match (e.g. "claude-opus-4-20250514" → "claude-opus-4")
  for (const [key, config] of _MODEL_PRICING_ENTRIES) {
    if (lower.startsWith(key)) return config;
  }

  return undefined;
}

// ── Usage Line Formatting ───────────────────────────────────────

/**
 * Format a usage summary line for display.
 *
 * Examples:
 *   "1.2k in / 2.5k out"
 *   "100k in / 50k out | cache 5.2k read / 1.3k write"
 *   "10k in / 20k out | est $0.05"
 *
 * @param {object} params
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} params.usage
 * @param {boolean} [params.showCost=true]
 * @param {ModelCostConfig} [params.costConfig]
 * @returns {string|null}
 */
function formatUsageLine({ usage, showCost = true, costConfig }) {
  if (!usage) return null;

  const input = usage.input || 0;
  const output = usage.output || 0;
  if (input === 0 && output === 0) return null;

  let line = `${formatTokenCount(input)} in / ${formatTokenCount(output)} out`;

  // Cache info
  const cacheRead = usage.cacheRead || 0;
  const cacheWrite = usage.cacheWrite || 0;
  if (cacheRead > 0 || cacheWrite > 0) {
    const parts = [];
    if (cacheRead > 0) parts.push(`${formatTokenCount(cacheRead)} cached`);
    if (cacheWrite > 0) parts.push(`${formatTokenCount(cacheWrite)} new`);
    line += ` | cache ${parts.join(' / ')}`;
  }

  // Cost estimate
  if (showCost) {
    const cost = costConfig || resolveModelCost(usage.model);
    if (cost) {
      const estimated = estimateUsageCost({ usage, cost });
      const formatted = formatUsd(estimated);
      if (formatted) line += ` | est ${formatted}`;
    }
  }

  return line;
}

module.exports = {
  formatTokenCount,
  formatUsd,
  normalizeTieredPricing,
  selectPricingTier,
  estimateUsageCost,
  resolveModelCost,
  formatUsageLine,
  DEFAULT_MODEL_PRICING,
};
