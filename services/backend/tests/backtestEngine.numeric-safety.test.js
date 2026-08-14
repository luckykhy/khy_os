'use strict';

// The engine lives at software/khyquant/services/backtestEngine.js and requires
// its dependencies via './klineDataService' etc., which resolve to the software
// copies — NOT the backend src/services re-exports. Mock the software paths the
// engine actually loads, otherwise the mock is silently bypassed and the engine
// falls through to live/hybrid data.
jest.mock('../../../software/khyquant/services/klineDataService', () => ({
  getKlineData: jest.fn(),
}));

jest.mock('../../../software/khyquant/services/comprehensiveDataService', () => ({
  getComprehensiveData: jest.fn(),
}));

const klineDataService = require('../../../software/khyquant/services/klineDataService');
const backtestEngine = require('../src/services/backtestEngine');

describe('backtest engine numeric safety', () => {
  test('skips invalid price bars and keeps metrics finite', async () => {
    klineDataService.getKlineData.mockResolvedValue([
      { date: '2024-01-01', open: 0, high: 0, low: 0, close: 0, volume: 1000 },
      { date: '2024-01-02', open: 100, high: 101, low: 99, close: 100, volume: 1200 },
      { date: '2024-01-03', open: 105, high: 106, low: 104, close: 105, volume: 1300 },
    ]);

    const result = await backtestEngine.run({
      symbol: 'TEST',
      startDate: '2024-01-01',
      endDate: '2024-01-03',
      initialCapital: 100000,
      signalFn: 'if (i === 0) return "buy"; if (i === bars.length - 1) return "sell"; return null;',
    });

    expect(result.finalCapital).toBe(105000);
    expect(result.totalTrades).toBe(2);
    expect(Number.isFinite(result.totalReturn)).toBe(true);
    expect(Number.isFinite(result.maxDrawdown)).toBe(true);
    expect(Number.isFinite(result.sharpeRatio)).toBe(true);
  });
});
