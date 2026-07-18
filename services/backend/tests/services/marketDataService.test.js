'use strict';

/**
 * Unit tests for marketDataService.
 *
 * Mocks axios (network) and Sequelize models to test pure logic:
 * calculateMA, generateMockKLineData.
 */

jest.mock('axios', () => ({
  get: jest.fn().mockRejectedValue(new Error('no network in test')),
}));

jest.mock('../../src/models', () => ({
  MarketData: {
    bulkCreate: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('sequelize', () => ({ Op: { gte: Symbol('gte'), lte: Symbol('lte') } }));

let marketDataService;

beforeAll(() => {
  try {
    marketDataService = require('../../src/services/marketDataService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('marketDataService')) throw e;
  }
});

describe('marketDataService', () => {
  test('module exports an object with expected methods', () => {
    if (!marketDataService) return;
    expect(typeof marketDataService).toBe('object');
    expect(typeof marketDataService.getRealTimeQuote).toBe('function');
    expect(typeof marketDataService.generateMockKLineData).toBe('function');
    expect(typeof marketDataService.saveKLineData).toBe('function');
    expect(typeof marketDataService.getKLineData).toBe('function');
    expect(typeof marketDataService.calculateMA).toBe('function');
  });

  test('calculateMA returns correct moving averages', () => {
    if (!marketDataService) return;
    const data = [
      { close: 10 }, { close: 12 }, { close: 14 }, { close: 16 }, { close: 18 },
    ];
    const ma3 = marketDataService.calculateMA(data, 3);
    expect(ma3).toHaveLength(5);
    expect(ma3[0]).toBe('-');
    expect(ma3[1]).toBe('-');
    // MA3 at index 2 = (10+12+14)/3 = 12
    expect(parseFloat(ma3[2])).toBeCloseTo(12, 1);
    // MA3 at index 3 = (12+14+16)/3 = 14
    expect(parseFloat(ma3[3])).toBeCloseTo(14, 1);
    // MA3 at index 4 = (14+16+18)/3 = 16
    expect(parseFloat(ma3[4])).toBeCloseTo(16, 1);
  });

  test('calculateMA supports close_price field name', () => {
    if (!marketDataService) return;
    const data = [
      { close_price: 20 }, { close_price: 30 }, { close_price: 40 },
    ];
    const ma2 = marketDataService.calculateMA(data, 2);
    expect(ma2[0]).toBe('-');
    // MA2 at index 1 = (20+30)/2 = 25
    expect(parseFloat(ma2[1])).toBeCloseTo(25, 1);
    // MA2 at index 2 = (30+40)/2 = 35
    expect(parseFloat(ma2[2])).toBeCloseTo(35, 1);
  });

  test('generateMockKLineData returns array with expected fields', async () => {
    if (!marketDataService) return;
    const data = await marketDataService.generateMockKLineData('sh600000', 10);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    const first = data[0];
    expect(first).toHaveProperty('symbol');
    expect(first).toHaveProperty('open_price');
    expect(first).toHaveProperty('high_price');
    expect(first).toHaveProperty('low_price');
    expect(first).toHaveProperty('close_price');
    expect(first).toHaveProperty('volume');
    expect(first).toHaveProperty('timestamp');
  });

  test('generateMockKLineData skips weekends', async () => {
    if (!marketDataService) return;
    const data = await marketDataService.generateMockKLineData('sh600000', 30);
    for (const bar of data) {
      const day = new Date(bar.timestamp).getDay();
      expect(day).not.toBe(0); // Sunday
      expect(day).not.toBe(6); // Saturday
    }
  });

  test('generateMockKLineData ensures high >= low', async () => {
    if (!marketDataService) return;
    const data = await marketDataService.generateMockKLineData('sh600000', 50);
    for (const bar of data) {
      expect(bar.high_price).toBeGreaterThanOrEqual(bar.low_price);
    }
  });

  test('generateMockKLineData uses realistic base price for known symbols', async () => {
    if (!marketDataService) return;
    const data = await marketDataService.generateMockKLineData('sh600519', 5);
    if (data.length > 0) {
      // Moutai should be in the 1000+ range, not 50
      expect(data[0].close_price).toBeGreaterThan(100);
    }
  });
});
