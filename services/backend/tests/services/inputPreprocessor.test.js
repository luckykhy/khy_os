'use strict';

/**
 * Tests for inputPreprocessor.js — input normalization, intent inference,
 * complexity assessment, and plan detection.
 */

// Mock external services that inputPreprocessor optionally loads
jest.mock('../../src/services/growthService', () => ({
  loadComponent: jest.fn(() => ({ frequentSymbols: [] })),
}), { virtual: true });

jest.mock('../../src/services/knowledgeTeachingService', () => ({
  getLevelProgress: jest.fn(() => ({ level: 'beginner', levelName: 'beginner', xp: 0 })),
}), { virtual: true });

jest.mock('../../src/services/usageHabitService', () => ({
  getHabitSummary: jest.fn(() => ({ topics: {} })),
}), { virtual: true });

const {
  preprocess,
  formatPlanDisplay,
  isPlanResponse,
  matchIntentRoutes,
} = require('../../src/services/inputPreprocessor');

describe('preprocess — basic behavior', () => {
  test('returns input unchanged for null/empty', () => {
    const result = preprocess(null);
    expect(result.processed).toBeNull();
    expect(result.enhanced).toBe(false);
    expect(result.needsPlan).toBe(false);
  });

  test('trims whitespace', () => {
    const result = preprocess('  hello  ');
    expect(result.processed).toBe('hello');
  });

  test('returns metadata with original length', () => {
    const result = preprocess('test input');
    expect(result.metadata.originalLength).toBe(10);
  });
});

describe('preprocess — stock code normalization', () => {
  test('adds sh prefix for 6-starting codes', () => {
    const result = preprocess('analyze 600519 please');
    expect(result.processed).toContain('sh600519');
  });

  test('adds sz prefix for 0-starting codes', () => {
    const result = preprocess('check 000001 now');
    expect(result.processed).toContain('sz000001');
  });

  test('lowercases SH/SZ prefixes', () => {
    const result = preprocess('look at SH600519');
    expect(result.processed).toContain('sh600519');
  });
});

describe('preprocess — common issue fixes', () => {
  test('removes space between exchange prefix and code', () => {
    const result = preprocess('sh 600519');
    expect(result.processed).toContain('sh600519');
  });

  test('standardizes date format', () => {
    const result = preprocess('data from 2024.1.5');
    expect(result.processed).toContain('2024-01-05');
  });

  test('reduces excessive punctuation', () => {
    const result = preprocess('really???!!!');
    expect(result.processed).toBe('really?!');
  });
});

describe('preprocess — intent inference', () => {
  test('infers query intent for bare stock code', () => {
    const result = preprocess('sh600519');
    expect(result.processed).toContain('sh600519');
    // Should infer a query intent
    expect(result.metadata.enhancements.length).toBeGreaterThan(0);
  });

  test('infers analysis intent for known stock name only', () => {
    const result = preprocess('茅台');
    expect(result.processed).toContain('茅台');
    expect(result.metadata.enhancements.some(e => e.type === 'intent_infer')).toBe(true);
  });
});

describe('preprocess — complexity assessment', () => {
  test('simple input does not need plan', () => {
    const result = preprocess('show price');
    expect(result.needsPlan).toBe(false);
  });

  test('complex multi-step input triggers plan', () => {
    const longInput = '首先分析贵州茅台的基本面，然后做技术分析，最后给出投资建议，并且比较和五粮液的优劣，同时又要回测最近一年的策略表现';
    const result = preprocess(longInput);
    // Should have high complexity score
    expect(result.complexity.score).toBeGreaterThan(0);
    expect(result.complexity.reasons.length).toBeGreaterThan(0);
  });
});

describe('formatPlanDisplay', () => {
  test('parses headers, steps, and bullets', () => {
    const plan = '## Task Breakdown\n1. Step one\n2. Step two\n- bullet item\nsome text';
    const result = formatPlanDisplay(plan);
    expect(result.find(r => r.type === 'header')).toBeDefined();
    expect(result.find(r => r.type === 'step')).toBeDefined();
    expect(result.find(r => r.type === 'bullet')).toBeDefined();
    expect(result.find(r => r.type === 'text')).toBeDefined();
  });

  test('skips empty lines', () => {
    const plan = '## Header\n\n1. Step';
    const result = formatPlanDisplay(plan);
    expect(result.every(r => r.text.trim().length > 0)).toBe(true);
  });
});

describe('isPlanResponse', () => {
  test('detects plan structure with Chinese headers', () => {
    expect(isPlanResponse('## 任务分解\n1. Step')).toBe(true);
    expect(isPlanResponse('## 执行计划\n1. Step')).toBe(true);
  });

  test('detects numbered list pattern', () => {
    expect(isPlanResponse('1. First\n2. Second\n3. Third')).toBe(true);
  });

  test('returns false for non-plan text', () => {
    expect(isPlanResponse('Hello world, no plan here.')).toBe(false);
  });
});

describe('matchIntentRoutes', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('routes short explicit intent keyword', () => {
    process.env.KHY_INTENT_ROUTE_MODE = 'strict';
    const matches = matchIntentRoutes('模型');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].route).toBe('gateway status');
  });

  test('does not hijack natural-language sentence containing keyword', () => {
    process.env.KHY_INTENT_ROUTE_MODE = 'balanced';
    const matches = matchIntentRoutes('大模型是怎么像人一样思考的呢');
    expect(matches).toEqual([]);
  });

  test('balanced mode allows short command-like phrase', () => {
    process.env.KHY_INTENT_ROUTE_MODE = 'balanced';
    const matches = matchIntentRoutes('查看模型状态');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].route).toBe('gateway status');
  });

  test('aggressive mode may route conversational short sentence', () => {
    process.env.KHY_INTENT_ROUTE_MODE = 'aggressive';
    const matches = matchIntentRoutes('大模型是怎么像人一样思考的呢');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].route).toBe('gateway status');
  });
});
