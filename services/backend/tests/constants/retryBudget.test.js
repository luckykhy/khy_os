'use strict';

const {
  MAX_RETRY_ROUNDS,
  clampRetryRounds,
} = require('../../src/constants/retryBudget');

describe('retryBudget', () => {
  describe('MAX_RETRY_ROUNDS', () => {
    test('is 10', () => {
      expect(MAX_RETRY_ROUNDS).toBe(10);
    });
  });

  describe('clampRetryRounds', () => {
    test('returns value within range', () => {
      expect(clampRetryRounds(5)).toBe(5);
      expect(clampRetryRounds(1)).toBe(1);
      expect(clampRetryRounds(10)).toBe(10);
    });

    test('clamps to minimum 1', () => {
      expect(clampRetryRounds(0)).toBe(1);
      expect(clampRetryRounds(-5)).toBe(1);
    });

    test('clamps to maximum 10', () => {
      expect(clampRetryRounds(11)).toBe(10);
      expect(clampRetryRounds(100)).toBe(10);
    });

    test('uses fallback for non-finite', () => {
      expect(clampRetryRounds(NaN)).toBe(10);
      expect(clampRetryRounds(undefined)).toBe(10);
      expect(clampRetryRounds(null)).toBe(10);
      expect(clampRetryRounds('abc')).toBe(10);
    });

    test('uses custom fallback', () => {
      expect(clampRetryRounds(NaN, 5)).toBe(5);
      expect(clampRetryRounds(undefined, 3)).toBe(3);
    });

    test('clamps fallback to range', () => {
      expect(clampRetryRounds(NaN, 15)).toBe(10);
      expect(clampRetryRounds(NaN, 0)).toBe(1);
    });

    test('floors decimal values', () => {
      expect(clampRetryRounds(5.5)).toBe(5);
      expect(clampRetryRounds(5.9)).toBe(5);
    });

    test('handles string numbers', () => {
      expect(clampRetryRounds('5')).toBe(5);
      expect(clampRetryRounds('10')).toBe(10);
    });
  });
});
