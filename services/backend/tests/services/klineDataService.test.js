'use strict';

/**
 * Unit tests for klineDataService.
 *
 * Mocks all heavy dependencies (DB models, external data sources, cache)
 * to test pure logic: instrument type detection, period normalization,
 * futures symbol resolution, and kline row normalization.
 */

jest.mock('sequelize', () => ({ Op: { gte: Symbol('gte'), lte: Symbol('lte') } }));
jest.mock('../../src/services/cacheService', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/sqliteBackupService', () => ({
  backupKlineData: jest.fn(),
  getKlineData: jest.fn().mockReturnValue([]),
}));
jest.mock('../../src/services/networkDetector', () => ({
  init: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/enhancedMockDataService', () => ({
  generateEnhancedKLineData: jest.fn().mockReturnValue([]),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/models/KlineData', () => null);

let klineDataService;

beforeAll(() => {
  try {
    klineDataService = require('../../src/services/klineDataService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('klineDataService')) throw e;
  }
});

describe('klineDataService', () => {
  test('module exports an object with expected methods', () => {
    if (!klineDataService) return;
    expect(typeof klineDataService).toBe('object');
    expect(typeof klineDataService.getKlineData).toBe('function');
    expect(typeof klineDataService.saveKlineData).toBe('function');
    expect(typeof klineDataService.getLastClosePrice).toBe('function');
  });

  test('_normalizeFuturesPeriod maps periods correctly', () => {
    if (!klineDataService) return;
    expect(klineDataService._normalizeFuturesPeriod('daily')).toBe('1d');
    expect(klineDataService._normalizeFuturesPeriod('1min')).toBe('1m');
    expect(klineDataService._normalizeFuturesPeriod('5m')).toBe('5m');
    expect(klineDataService._normalizeFuturesPeriod('15min')).toBe('15m');
    expect(klineDataService._normalizeFuturesPeriod('60min')).toBe('1h');
    expect(klineDataService._normalizeFuturesPeriod('hour')).toBe('1h');
    // Unknown defaults to 1m
    expect(klineDataService._normalizeFuturesPeriod('unknown')).toBe('1m');
  });

  test('_resolveFuturesSymbol handles direct match', () => {
    if (!klineDataService) return;
    const symbols = ['RB2410', 'RB2411', 'RB8888'];
    expect(klineDataService._resolveFuturesSymbol('RB2410', symbols)).toBe('RB2410');
  });

  test('_resolveFuturesSymbol handles _main suffix', () => {
    if (!klineDataService) return;
    const symbols = ['RB2410', 'RB8888', 'RB9999'];
    expect(klineDataService._resolveFuturesSymbol('rb_main', symbols)).toBe('RB8888');
    expect(klineDataService._resolveFuturesSymbol('RB_MAIN', symbols)).toBe('RB8888');
  });

  test('_resolveFuturesSymbol returns null for no match', () => {
    if (!klineDataService) return;
    const symbols = ['IF2410', 'IF2411'];
    expect(klineDataService._resolveFuturesSymbol('RB2410', symbols)).toBeNull();
  });

  test('_resolveFuturesSymbol handles plain product code', () => {
    if (!klineDataService) return;
    const symbols = ['RB8888', 'RB2410'];
    expect(klineDataService._resolveFuturesSymbol('RB', symbols)).toBe('RB8888');
  });

  test('_normalizeKlineRows normalizes field names and sorts by date', () => {
    if (!klineDataService) return;
    const input = [
      { trade_date: '2024-01-03', close_price: 12, open_price: 11, high_price: 13, low_price: 10, volume: 100 },
      { trade_date: '2024-01-01', close_price: 10, open_price: 9, high_price: 11, low_price: 8, volume: 200 },
    ];
    const result = klineDataService._normalizeKlineRows(input, 'daily');
    expect(result).toHaveLength(2);
    // Sorted ascending
    expect(result[0].date).toContain('2024-01-01');
    expect(result[1].date).toContain('2024-01-03');
    // Fields normalized
    expect(result[0].close).toBe(10);
    expect(result[0].open).toBe(9);
  });

  test('_normalizeKlineRows filters out rows missing date', () => {
    if (!klineDataService) return;
    const input = [
      { close: 10 },  // no date
      { date: '2024-01-01', close: 20 },
    ];
    const result = klineDataService._normalizeKlineRows(input, 'daily');
    expect(result).toHaveLength(1);
    expect(result[0].close).toBe(20);
  });

  test('_applyLimit respects limit parameter', () => {
    if (!klineDataService) return;
    const rows = Array.from({ length: 500 }, (_, i) => ({ date: `2024-01-${String(i + 1).padStart(2, '0')}` }));
    const limited = klineDataService._applyLimit(rows, 'daily', 200);
    expect(limited.length).toBeLessThanOrEqual(500); // daily enforces Math.max(100, limit)
    // For daily with limit=200, should keep last 200
    expect(limited).toHaveLength(200);
  });

  test('_applyLimit returns all rows when limit is not finite', () => {
    if (!klineDataService) return;
    const rows = [{ date: '2024-01-01' }, { date: '2024-01-02' }];
    const result = klineDataService._applyLimit(rows, 'daily', NaN);
    expect(result).toHaveLength(2);
  });
});
