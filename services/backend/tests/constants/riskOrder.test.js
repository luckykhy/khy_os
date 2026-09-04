'use strict';

const {
  RISK_ORDER,
  RISK_LEVELS,
} = require('../../src/constants/riskOrder');

describe('riskOrder', () => {
  describe('RISK_ORDER', () => {
    test('has correct ordinal values', () => {
      expect(RISK_ORDER.safe).toBe(0);
      expect(RISK_ORDER.low).toBe(1);
      expect(RISK_ORDER.medium).toBe(2);
      expect(RISK_ORDER.high).toBe(3);
      expect(RISK_ORDER.critical).toBe(4);
    });

    test('is frozen', () => {
      expect(Object.isFrozen(RISK_ORDER)).toBe(true);
    });
  });

  describe('RISK_LEVELS', () => {
    test('has correct order', () => {
      expect(RISK_LEVELS).toEqual(['safe', 'low', 'medium', 'high', 'critical']);
    });

    test('is frozen', () => {
      expect(Object.isFrozen(RISK_LEVELS)).toBe(true);
    });

    test('matches RISK_ORDER ordinals', () => {
      expect(RISK_LEVELS[RISK_ORDER.safe]).toBe('safe');
      expect(RISK_LEVELS[RISK_ORDER.low]).toBe('low');
      expect(RISK_LEVELS[RISK_ORDER.medium]).toBe('medium');
      expect(RISK_LEVELS[RISK_ORDER.high]).toBe('high');
      expect(RISK_LEVELS[RISK_ORDER.critical]).toBe('critical');
    });
  });
});
