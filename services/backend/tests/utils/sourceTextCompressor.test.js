'use strict';

const { compress, estimateTokens, wouldCompress } = require('../../src/utils/sourceTextCompressor');

describe('sourceTextCompressor', () => {
  describe('compress', () => {
    test('returns empty for empty input', () => {
      const result = compress('');
      expect(result.compressed).toBe('');
      expect(result.stats.originalBytes).toBe(0);
    });

    test('strips trailing whitespace', () => {
      const result = compress('hello   \nworld   ');
      expect(result.compressed).toBe('hello\nworld');
    });

    test('merges consecutive blank lines', () => {
      const result = compress('hello\n\n\n\nworld');
      expect(result.compressed).toBe('hello\n\nworld');
    });

    test('trims trailing blank lines', () => {
      const result = compress('hello\n\n\n');
      expect(result.compressed).toBe('hello');
    });

    test('calculates stats', () => {
      const result = compress('hello\n\n\nworld');
      expect(result.stats.originalBytes).toBeGreaterThan(0);
      expect(result.stats.compressedBytes).toBeGreaterThan(0);
      expect(result.stats.ratio).toBeLessThan(1);
      expect(result.stats.savedPercent).toBeGreaterThan(0);
    });
  });

  describe('estimateTokens', () => {
    test('returns 0 for empty input', () => {
      expect(estimateTokens('')).toBe(0);
    });

    test('estimates tokens for English', () => {
      expect(estimateTokens('hello world')).toBe(3);
    });

    test('estimates tokens for CJK', () => {
      expect(estimateTokens('你好世界')).toBe(4);
    });
  });

  describe('wouldCompress', () => {
    test('returns false for short text', () => {
      expect(wouldCompress('short')).toBe(false);
    });

    test('returns true for text with blank lines', () => {
      expect(wouldCompress('hello\n\n\n\nworld'.repeat(20))).toBe(true);
    });

    test('returns true for text with trailing whitespace', () => {
      expect(wouldCompress('hello   \n'.repeat(20))).toBe(true);
    });
  });
});
