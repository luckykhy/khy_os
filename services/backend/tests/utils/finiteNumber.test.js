'use strict';

const { toFiniteOr0, toPositiveOr0, toNonNegOr0 } = require('../../src/utils/finiteNumber');

describe('finiteNumber', () => {
  describe('toFiniteOr0', () => {
    test('returns finite number', () => {
      expect(toFiniteOr0(42)).toBe(42);
    });

    test('returns 0 for NaN', () => {
      expect(toFiniteOr0(NaN)).toBe(0);
    });

    test('returns 0 for Infinity', () => {
      expect(toFiniteOr0(Infinity)).toBe(0);
    });

    test('preserves negative numbers', () => {
      expect(toFiniteOr0(-5)).toBe(-5);
    });
  });

  describe('toPositiveOr0', () => {
    test('returns positive number', () => {
      expect(toPositiveOr0(42)).toBe(42);
    });

    test('returns 0 for negative', () => {
      expect(toPositiveOr0(-5)).toBe(0);
    });

    test('returns 0 for zero', () => {
      expect(toPositiveOr0(0)).toBe(0);
    });

    test('returns 0 for NaN', () => {
      expect(toPositiveOr0(NaN)).toBe(0);
    });
  });

  describe('toNonNegOr0', () => {
    test('returns non-negative number', () => {
      expect(toNonNegOr0(42)).toBe(42);
    });

    test('returns 0 for zero', () => {
      expect(toNonNegOr0(0)).toBe(0);
    });

    test('returns 0 for negative', () => {
      expect(toNonNegOr0(-5)).toBe(0);
    });

    test('returns 0 for NaN', () => {
      expect(toNonNegOr0(NaN)).toBe(0);
    });
  });
});
