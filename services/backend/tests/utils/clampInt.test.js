'use strict';

const clampInt = require('../../src/utils/clampInt');

describe('clampInt', () => {
  test('clamps value within range', () => {
    expect(clampInt(5, 0, 10, 0)).toBe(5);
  });

  test('clamps value below lower bound', () => {
    expect(clampInt(-5, 0, 10, 0)).toBe(0);
  });

  test('clamps value above upper bound', () => {
    expect(clampInt(15, 0, 10, 0)).toBe(10);
  });

  test('rounds to nearest integer', () => {
    expect(clampInt(5.4, 0, 10, 0)).toBe(5);
    expect(clampInt(5.6, 0, 10, 0)).toBe(6);
  });

  test('uses fallback for non-finite values', () => {
    expect(clampInt(NaN, 0, 10, 3)).toBe(3);
    expect(clampInt(Infinity, 0, 10, 3)).toBe(3);
    expect(clampInt(-Infinity, 0, 10, 3)).toBe(3);
  });

  test('handles string numbers', () => {
    expect(clampInt('7', 0, 10, 0)).toBe(7);
  });

  test('handles negative range', () => {
    expect(clampInt(-5, -10, -1, 0)).toBe(-5);
    expect(clampInt(-15, -10, -1, 0)).toBe(-10);
    expect(clampInt(0, -10, -1, 0)).toBe(-1);
  });
});
