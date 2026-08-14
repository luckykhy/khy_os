'use strict';

/**
 * Tests for tokenUsageService.js — pure function tests.
 * Avoids disk I/O by testing estimateTokens, calculateCost, and
 * session-level functions after resetUsage().
 */

// Mock fs to prevent real disk I/O
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock subscriptionService to avoid external dependency
jest.mock('../../src/services/subscriptionService', () => ({
  getCurrentTier: () => 'free',
  TIERS: { free: { limits: { cloud_ai_tokens: 100000 } } },
}), { virtual: true });

const {
  estimateTokens,
  calculateCost,
  recordUsage,
  getSessionUsage,
  resetUsage,
  recordCompressionSavings,
  getCompressionStats,
  TOKEN_PRICING,
  USD_TO_CNY,
} = require('../../src/services/tokenUsageService');

beforeEach(() => {
  resetUsage();
});

describe('estimateTokens', () => {
  test('returns 0 for null/undefined/empty input', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens('')).toBe(0);
  });

  test('estimates English text at ~4 chars per token', () => {
    const text = 'Hello world, this is a test string for estimation.';
    const tokens = estimateTokens(text);
    // 50 chars / 4 = ~12-13 tokens
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(25);
  });

  test('estimates Chinese text at ~1.5 chars per token', () => {
    const text = '你好世界测试字符串';
    const tokens = estimateTokens(text);
    // 9 CJK chars / 1.5 = 6 tokens
    expect(tokens).toBe(6);
  });

  test('handles mixed CJK and ASCII text', () => {
    const text = 'Hello你好World世界';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });

  test('returns integer values (ceiling)', () => {
    const text = 'a';
    const tokens = estimateTokens(text);
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

describe('calculateCost', () => {
  test('calculates cost for known provider', () => {
    const { costUSD, costCNY } = calculateCost('OpenAI', 1000000, 500000);
    // OpenAI: input $0.15/1M, output $0.60/1M
    // cost = (1M * 0.15 + 500K * 0.60) / 1M = 0.15 + 0.30 = 0.45
    expect(costUSD).toBeCloseTo(0.45, 4);
    expect(costCNY).toBeCloseTo(costUSD * USD_TO_CNY, 4);
  });

  test('uses default pricing for unknown provider', () => {
    const { costUSD } = calculateCost('UnknownProvider', 1000000, 1000000);
    const defaultPricing = TOKEN_PRICING['default'];
    const expected = (1000000 * defaultPricing.input + 1000000 * defaultPricing.output) / 1000000;
    expect(costUSD).toBeCloseTo(expected, 6);
  });

  test('returns zero cost for local/free providers', () => {
    const { costUSD, costCNY } = calculateCost('Ollama', 100000, 50000);
    expect(costUSD).toBe(0);
    expect(costCNY).toBe(0);
  });

  test('returns CNY using USD_TO_CNY exchange rate', () => {
    const { costUSD, costCNY } = calculateCost('Anthropic', 100000, 50000);
    expect(costCNY).toBeCloseTo(costUSD * USD_TO_CNY, 6);
  });

  test('handles zero tokens', () => {
    const { costUSD } = calculateCost('OpenAI', 0, 0);
    expect(costUSD).toBe(0);
  });
});

describe('session usage tracking', () => {
  test('starts with zero session usage after reset', () => {
    const usage = getSessionUsage();
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
    expect(usage.requests).toBe(0);
  });

  test('recordUsage accumulates session tokens', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 200, 0.01);
    recordUsage('OpenAI', 'gpt-4o-mini', 50, 75, 0.005);
    const usage = getSessionUsage();
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(275);
    expect(usage.totalTokens).toBe(425);
    expect(usage.requests).toBe(2);
  });

  test('resetUsage clears session data', () => {
    recordUsage('OpenAI', 'gpt-4o-mini', 100, 200);
    resetUsage();
    const usage = getSessionUsage();
    expect(usage.totalTokens).toBe(0);
    expect(usage.requests).toBe(0);
  });
});

describe('compression stats', () => {
  test('starts at zero after reset', () => {
    const stats = getCompressionStats();
    expect(stats.originalTokens).toBe(0);
    expect(stats.savedPercent).toBe(0);
    expect(stats.requests).toBe(0);
  });

  test('tracks compression savings correctly', () => {
    recordCompressionSavings(1000, 600);
    recordCompressionSavings(2000, 1200);
    const stats = getCompressionStats();
    expect(stats.originalTokens).toBe(3000);
    expect(stats.compressedTokens).toBe(1800);
    expect(stats.savedTokens).toBe(1200);
    expect(stats.savedPercent).toBe(40);
    expect(stats.requests).toBe(2);
  });

  test('handles case where compressed > original (no negative savings)', () => {
    recordCompressionSavings(100, 150);
    const stats = getCompressionStats();
    expect(stats.savedTokens).toBe(0);
  });
});
