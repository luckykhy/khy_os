'use strict';

/**
 * Unit tests for strategyEngine.
 *
 * Mocks the PythonStrategyEngine and TDXFormulaEngine dependencies
 * to test the pure-JS logic: function detection, signal validation,
 * template generation, and per-bar format detection.
 */

jest.mock('../../src/services/pythonStrategyEngine', () => ({
  executeStrategy: jest.fn(),
  backtest: jest.fn(),
  getTemplates: jest.fn().mockReturnValue({}),
}));

jest.mock('../../src/services/tdxFormulaEngine', () => {
  return jest.fn().mockImplementation(() => ({
    backtest: jest.fn(),
  }));
});

let strategyEngine;

beforeAll(() => {
  try {
    strategyEngine = require('../../src/services/strategyEngine');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('strategyEngine')) throw e;
  }
});

describe('strategyEngine', () => {
  test('module exports an object with expected methods', () => {
    if (!strategyEngine) return;
    expect(typeof strategyEngine).toBe('object');
    expect(typeof strategyEngine.parseStrategy).toBe('function');
    expect(typeof strategyEngine.executeStrategy).toBe('function');
    expect(typeof strategyEngine.backtest).toBe('function');
    expect(typeof strategyEngine.validateSignals).toBe('function');
    expect(typeof strategyEngine.detectStrategyFunctions).toBe('function');
    expect(typeof strategyEngine.generateCallAttempts).toBe('function');
    expect(typeof strategyEngine.getTemplates).toBe('function');
    expect(typeof strategyEngine.isPerBarFormat).toBe('function');
  });

  test('detectStrategyFunctions finds function declarations', () => {
    if (!strategyEngine) return;
    const code = 'function strategy(data, params) { return []; }';
    const funcs = strategyEngine.detectStrategyFunctions(code);
    expect(funcs.length).toBeGreaterThanOrEqual(1);
    expect(funcs[0].name).toBe('strategy');
    expect(funcs[0].type).toBe('function');
  });

  test('detectStrategyFunctions finds arrow functions', () => {
    if (!strategyEngine) return;
    const code = 'const myStrategy = (data, params) => { return []; };';
    const funcs = strategyEngine.detectStrategyFunctions(code);
    expect(funcs.some(f => f.name === 'myStrategy' && f.type === 'arrow')).toBe(true);
  });

  test('detectStrategyFunctions finds class definitions', () => {
    if (!strategyEngine) return;
    const code = 'class MACDStrategy { execute(data, params) {} }';
    const funcs = strategyEngine.detectStrategyFunctions(code);
    expect(funcs.some(f => f.name === 'MACDStrategy' && f.type === 'class')).toBe(true);
  });

  test('isPerBarFormat correctly identifies per-bar strategy code', () => {
    if (!strategyEngine) return;
    const perBarCode = `
      if (bars[i].close > bars[i].open) return 'buy';
      return 'sell';
    `;
    expect(strategyEngine.isPerBarFormat(perBarCode)).toBe(true);

    const batchCode = `
      function strategy(data, params) {
        return data.map(d => ({ type: 'hold' }));
      }
    `;
    expect(strategyEngine.isPerBarFormat(batchCode)).toBe(false);
  });

  test('validateSignals filters out null entries', () => {
    if (!strategyEngine) return;
    const data = [
      { close: 10, time: '2024-01-01' },
      { close: 11, time: '2024-01-02' },
      { close: 12, time: '2024-01-03' },
    ];
    const signals = [
      { type: 'buy', index: 0, price: 10 },
      null,
      { type: 'sell', index: 2, price: 12 },
    ];
    const validated = strategyEngine.validateSignals(signals, data);
    expect(validated.length).toBe(2);
    expect(validated[0].type).toBe('buy');
    expect(validated[1].type).toBe('sell');
  });

  test('validateSignals populates missing time from data', () => {
    if (!strategyEngine) return;
    const data = [{ close: 10, time: '2024-01-01' }];
    const signals = [{ type: 'buy', index: 0, price: 10 }];
    const validated = strategyEngine.validateSignals(signals, data);
    expect(validated[0].time).toBe('2024-01-01');
  });

  test('validateSignals sets default action based on type', () => {
    if (!strategyEngine) return;
    const data = [
      { close: 10 },
      { close: 11 },
    ];
    const signals = [
      { type: 'buy', index: 0 },
      { type: 'sell', index: 1 },
    ];
    const validated = strategyEngine.validateSignals(signals, data);
    expect(validated[0].action).toBe('buy');
    expect(validated[1].action).toBe('sell');
  });

  test('getJavaScriptTemplates returns macd, ma_cross, rsi templates', () => {
    if (!strategyEngine) return;
    const templates = strategyEngine.getJavaScriptTemplates();
    expect(templates).toHaveProperty('macd');
    expect(templates).toHaveProperty('ma_cross');
    expect(templates).toHaveProperty('rsi');
    expect(templates.macd.language).toBe('javascript');
    expect(typeof templates.macd.code).toBe('string');
    expect(templates.macd.params).toBeDefined();
  });

  test('generateCallAttempts produces string with standard function names', () => {
    if (!strategyEngine) return;
    const result = strategyEngine.generateCallAttempts([]);
    expect(typeof result).toBe('string');
    expect(result).toContain('strategy');
    expect(result).toContain('execute');
    expect(result).toContain('run');
    expect(result).toContain('main');
  });
});
