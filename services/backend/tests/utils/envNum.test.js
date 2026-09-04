'use strict';

const envNum = require('../../src/utils/envNum');

describe('envNum', () => {
  test('returns parsed number', () => {
    expect(envNum({ TEST: '42' }, 'TEST')).toBe(42);
  });

  test('returns undefined for missing key', () => {
    expect(envNum({}, 'MISSING')).toBeUndefined();
  });

  test('returns undefined for null value', () => {
    expect(envNum({ TEST: null }, 'TEST')).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(envNum({ TEST: '' }, 'TEST')).toBeUndefined();
  });

  test('returns undefined for whitespace', () => {
    expect(envNum({ TEST: '   ' }, 'TEST')).toBeUndefined();
  });

  test('returns undefined for non-numeric', () => {
    expect(envNum({ TEST: 'abc' }, 'TEST')).toBeUndefined();
  });

  test('handles float', () => {
    expect(envNum({ TEST: '3.14' }, 'TEST')).toBeCloseTo(3.14);
  });

  test('handles null env', () => {
    expect(envNum(null, 'TEST')).toBeUndefined();
  });
});
