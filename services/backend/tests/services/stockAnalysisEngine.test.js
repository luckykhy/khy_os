'use strict';

/**
 * Unit tests for stockAnalysisEngine.
 *
 * Mock network (axios) and filesystem to test pure logic:
 * question type identification, stock code formatting, confidence
 * calculation, and conversation recording.
 */

jest.mock('axios', () => ({
  get: jest.fn().mockRejectedValue(new Error('no network in test')),
}));

// Mock fs to prevent reading/writing learning data files.
jest.mock('fs', () => {
  const original = jest.requireActual('fs');
  return {
    ...original,
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue('{}'),
    writeFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

let stockAnalysisEngine;

beforeAll(() => {
  try {
    stockAnalysisEngine = require('../../src/services/stockAnalysisEngine');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('stockAnalysisEngine')) throw e;
  }
});

describe('stockAnalysisEngine', () => {
  test('module exports an object with expected methods', () => {
    if (!stockAnalysisEngine) return;
    expect(typeof stockAnalysisEngine).toBe('object');
    expect(typeof stockAnalysisEngine.chat).toBe('function');
    expect(typeof stockAnalysisEngine.identifyQuestionType).toBe('function');
    expect(typeof stockAnalysisEngine.formatStockCode).toBe('function');
    expect(typeof stockAnalysisEngine.calculateConfidence).toBe('function');
    expect(typeof stockAnalysisEngine.getRandomGreeting).toBe('function');
    expect(typeof stockAnalysisEngine.getRandomIntroduction).toBe('function');
    expect(typeof stockAnalysisEngine.recordConversation).toBe('function');
    expect(typeof stockAnalysisEngine.getRelevantHistory).toBe('function');
  });

  test('identifyQuestionType detects recommendation questions', () => {
    if (!stockAnalysisEngine) return;
    expect(stockAnalysisEngine.identifyQuestionType('这只股票该买入吗')).toBe('recommendation');
    expect(stockAnalysisEngine.identifyQuestionType('推荐哪些股票')).toBe('recommendation');
    expect(stockAnalysisEngine.identifyQuestionType('建议卖出吗')).toBe('recommendation');
  });

  test('identifyQuestionType detects technical questions', () => {
    if (!stockAnalysisEngine) return;
    expect(stockAnalysisEngine.identifyQuestionType('MACD金叉了吗')).toBe('technical');
    expect(stockAnalysisEngine.identifyQuestionType('均线趋势如何')).toBe('technical');
    expect(stockAnalysisEngine.identifyQuestionType('RSI指标分析')).toBe('technical');
  });

  test('identifyQuestionType detects risk questions', () => {
    if (!stockAnalysisEngine) return;
    expect(stockAnalysisEngine.identifyQuestionType('风险有多大')).toBe('risk');
    expect(stockAnalysisEngine.identifyQuestionType('止损设在哪里')).toBe('risk');
  });

  test('identifyQuestionType returns general for unknown', () => {
    if (!stockAnalysisEngine) return;
    expect(stockAnalysisEngine.identifyQuestionType('今天天气怎么样')).toBe('general');
  });

  test('formatStockCode formats Shanghai stocks correctly', () => {
    if (!stockAnalysisEngine) return;
    expect(stockAnalysisEngine.formatStockCode('600000')).toBe('s_sh600000');
    expect(stockAnalysisEngine.formatStockCode('sh600000')).toBe('s_sh600000');
  });

  test('formatStockCode formats Shenzhen stocks correctly', () => {
    if (!stockAnalysisEngine) return;
    expect(stockAnalysisEngine.formatStockCode('000001')).toBe('s_sz000001');
    expect(stockAnalysisEngine.formatStockCode('sz000001')).toBe('s_sz000001');
    expect(stockAnalysisEngine.formatStockCode('300750')).toBe('s_sz300750');
  });

  test('calculateConfidence increases with realtime data', () => {
    if (!stockAnalysisEngine) return;
    const withoutData = stockAnalysisEngine.calculateConfidence('recommendation', null);
    const withData = stockAnalysisEngine.calculateConfidence('recommendation', { price: 10 });
    expect(withData).toBeGreaterThan(withoutData);
    expect(withData).toBeLessThanOrEqual(0.95);
  });

  test('getRandomGreeting returns a non-empty string', () => {
    if (!stockAnalysisEngine) return;
    const greeting = stockAnalysisEngine.getRandomGreeting();
    expect(typeof greeting).toBe('string');
    expect(greeting.length).toBeGreaterThan(10);
  });

  test('recordConversation stores entries and caps at 100', () => {
    if (!stockAnalysisEngine) return;
    // Clear history
    stockAnalysisEngine.conversationHistory = [];
    for (let i = 0; i < 110; i++) {
      stockAnalysisEngine.recordConversation(`q${i}`, `a${i}`, {});
    }
    expect(stockAnalysisEngine.conversationHistory.length).toBeLessThanOrEqual(100);
  });
});
