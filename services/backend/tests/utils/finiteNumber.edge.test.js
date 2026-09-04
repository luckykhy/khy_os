'use strict';

const {
  toFiniteOr0,
  toPositiveOr0,
  toNonNegOr0,
} = require('../../src/utils/finiteNumber');

describe('finiteNumber edge cases', () => {
  test('toFiniteOr0 handles string numbers', () => {
    expect(toFiniteOr0('42')).toBe(42);
    expect(toFiniteOr0('abc')).toBe(0);
  });

  test('toPositiveOr0 handles string numbers', () => {
    expect(toPositiveOr0('42')).toBe(42);
    expect(toPositiveOr0('-5')).toBe(0);
  });

  test('toNonNegOr0 handles string numbers', () => {
    expect(toNonNegOr0('42')).toBe(42);
    expect(toNonNegOr0('-5')).toBe(0);
  });
});
