'use strict';

/**
 * Tests for tokenPricing.js — pure pricing/conversion math leaf.
 *
 * Batch 3 提取自 tokenUsageService.js;本测试覆盖:
 * 零 token、未知 provider、缺失/畸形价格表、负数/非数字输入、
 * 注入自定义价格表与汇率、记录求和、token 估算等边界。
 */

const {
  TOKEN_PRICING,
  USD_TO_CNY,
  resolveProviderPricing,
  calculateCost,
  estimateCost,
  sumRecordsCost,
  estimateTokens,
} = require('../../src/services/tokenPricing');

describe('constants', () => {
  test('TOKEN_PRICING has a default entry and known providers', () => {
    expect(TOKEN_PRICING.default).toEqual({ input: 0.10, output: 0.30 });
    expect(TOKEN_PRICING['OpenAI']).toEqual({ input: 0.15, output: 0.60 });
    expect(TOKEN_PRICING['Ollama']).toEqual({ input: 0, output: 0 });
  });

  test('USD_TO_CNY is a positive finite number', () => {
    expect(Number.isFinite(USD_TO_CNY)).toBe(true);
    expect(USD_TO_CNY).toBeGreaterThan(0);
  });
});

describe('resolveProviderPricing', () => {
  test('resolves known provider from built-in table', () => {
    expect(resolveProviderPricing('Anthropic')).toBe(TOKEN_PRICING['Anthropic']);
  });

  test('falls back to default for unknown provider', () => {
    expect(resolveProviderPricing('NoSuchProvider')).toBe(TOKEN_PRICING.default);
  });

  test('falls back to default for undefined/null provider', () => {
    expect(resolveProviderPricing(undefined)).toBe(TOKEN_PRICING.default);
    expect(resolveProviderPricing(null)).toBe(TOKEN_PRICING.default);
  });

  test('non-object table falls back to built-in table', () => {
    expect(resolveProviderPricing('OpenAI', null)).toBe(TOKEN_PRICING['OpenAI']);
    expect(resolveProviderPricing('OpenAI', 'garbage')).toBe(TOKEN_PRICING['OpenAI']);
  });

  test('malformed table without default yields zero pricing', () => {
    const table = Object.create(null);
    table['X'] = { input: 1, output: 2 };
    expect(resolveProviderPricing('Y', table)).toEqual({ input: 0, output: 0 });
  });
});

describe('calculateCost', () => {
  test('calculates cost for known provider', () => {
    const { costUSD, costCNY } = calculateCost('OpenAI', 1000000, 500000);
    // (1M * 0.15 + 500K * 0.60) / 1M = 0.45
    expect(costUSD).toBeCloseTo(0.45, 6);
    expect(costCNY).toBeCloseTo(0.45 * USD_TO_CNY, 6);
  });

  test('zero tokens yield zero cost', () => {
    const { costUSD, costCNY } = calculateCost('Anthropic', 0, 0);
    expect(costUSD).toBe(0);
    expect(costCNY).toBe(0);
  });

  test('unknown provider uses default pricing', () => {
    const { costUSD } = calculateCost('UnknownProvider', 1000000, 1000000);
    expect(costUSD).toBeCloseTo(0.10 + 0.30, 6);
  });

  test('free/local providers cost zero', () => {
    const { costUSD, costCNY } = calculateCost('Ollama', 123456, 654321);
    expect(costUSD).toBe(0);
    expect(costCNY).toBe(0);
  });

  test('negative tokens propagate as negative cost (no clamping, pre-extraction semantics)', () => {
    const { costUSD } = calculateCost('OpenAI', -1000000, 0);
    expect(costUSD).toBeCloseTo(-0.15, 6);
  });

  test('non-numeric tokens propagate NaN (pre-extraction semantics)', () => {
    const { costUSD, costCNY } = calculateCost('OpenAI', 'abc', 100);
    expect(Number.isNaN(costUSD)).toBe(true);
    expect(Number.isNaN(costCNY)).toBe(true);
  });

  test('accepts injected pricing table and exchange rate', () => {
    const table = { 'default': { input: 1, output: 2 }, 'P': { input: 10, output: 20 } };
    const { costUSD, costCNY } = calculateCost('P', 1000000, 1000000, table, 2);
    expect(costUSD).toBeCloseTo(30, 6);
    expect(costCNY).toBeCloseTo(60, 6);
  });

  test('malformed injected table without default yields zero cost', () => {
    const table = Object.create(null);
    const { costUSD } = calculateCost('P', 1000000, 1000000, table);
    expect(costUSD).toBe(0);
  });
});

describe('estimateCost', () => {
  test('matches provider key by case-insensitive substring', () => {
    // 'gpt-4o via openai' contains 'openai' -> OpenAI pricing
    const usd = estimateCost(1000000, 0, 'something-OpenAI-flavored');
    expect(usd).toBeCloseTo(0.15, 6);
  });

  test('falls back to default when nothing matches', () => {
    const usd = estimateCost(1000000, 1000000, 'totally-unknown-model');
    expect(usd).toBeCloseTo(0.40, 6);
  });

  test('handles empty/undefined model name via default pricing', () => {
    expect(estimateCost(0, 0, undefined)).toBe(0);
    expect(estimateCost(1000000, 0, '')).toBeCloseTo(0.10, 6);
  });

  test('zero tokens yield zero cost', () => {
    expect(estimateCost(0, 0, 'OpenAI')).toBe(0);
  });

  test('first insertion-order match wins', () => {
    const table = {
      'aa': { input: 1, output: 1 },
      'aab': { input: 100, output: 100 },
      'default': { input: 0, output: 0 },
    };
    // 'aab-model' contains both 'aa' and 'aab'; first key wins.
    const usd = estimateCost(1000000, 0, 'aab-model', table);
    expect(usd).toBeCloseTo(1, 6);
  });

  test('non-object table falls back to built-in table', () => {
    const usd = estimateCost(1000000, 0, 'openai-ish', null);
    expect(usd).toBeCloseTo(0.15, 6);
  });

  test('malformed table without default yields zero cost', () => {
    const table = { 'X': { input: 5, output: 5 } };
    const usd = estimateCost(1000000, 1000000, 'no-match', table);
    expect(usd).toBe(0);
  });

  test('negative tokens propagate (no clamping)', () => {
    const usd = estimateCost(-1000000, 0, 'no-match-uses-default');
    expect(usd).toBeCloseTo(-0.10, 6);
  });
});

describe('sumRecordsCost', () => {
  test('empty or non-array records yield zero cost', () => {
    expect(sumRecordsCost([])).toEqual({ costUSD: 0, costCNY: 0 });
    expect(sumRecordsCost(null)).toEqual({ costUSD: 0, costCNY: 0 });
    expect(sumRecordsCost(undefined)).toEqual({ costUSD: 0, costCNY: 0 });
  });

  test('sums cost across records with per-provider pricing', () => {
    const records = [
      { provider: 'OpenAI', inputTokens: 1000000, outputTokens: 0 },      // 0.15
      { provider: 'Anthropic', inputTokens: 0, outputTokens: 1000000 },   // 15.00
      { provider: 'Unknown', inputTokens: 1000000, outputTokens: 0 },     // 0.10 (default)
    ];
    const { costUSD, costCNY } = sumRecordsCost(records);
    expect(costUSD).toBeCloseTo(15.25, 6);
    expect(costCNY).toBeCloseTo(15.25 * USD_TO_CNY, 6);
  });

  test('records with missing provider use default pricing', () => {
    const { costUSD } = sumRecordsCost([{ inputTokens: 1000000, outputTokens: 0 }]);
    expect(costUSD).toBeCloseTo(0.10, 6);
  });

  test('non-numeric token fields propagate NaN', () => {
    const { costUSD } = sumRecordsCost([{ provider: 'OpenAI', inputTokens: 'x', outputTokens: 1 }]);
    expect(Number.isNaN(costUSD)).toBe(true);
  });

  test('accepts injected table and exchange rate', () => {
    const table = { 'default': { input: 1, output: 1 } };
    const { costUSD, costCNY } = sumRecordsCost(
      [{ provider: 'Z', inputTokens: 500000, outputTokens: 500000 }], table, 10);
    expect(costUSD).toBeCloseTo(1, 6);
    expect(costCNY).toBeCloseTo(10, 6);
  });
});

describe('estimateTokens', () => {
  test('returns 0 for null/undefined/empty input', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('')).toBe(0);
  });

  test('estimates English text at ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  test('estimates CJK text at ~1.5 chars per token', () => {
    expect(estimateTokens('你好世界测试字符串')).toBe(6); // 9 / 1.5
  });

  test('handles mixed CJK and ASCII with ceiling', () => {
    // 4 CJK / 1.5 + 10 ASCII / 4 = 2.667 + 2.5 = 5.167 -> 6
    expect(estimateTokens('Hello你好World世界')).toBe(Math.ceil(4 / 1.5 + 10 / 4));
  });
});
