'use strict';

/**
 * Unit tests for parseContextOverflowTokens() in errorClassifier.js.
 *
 * Covers:
 *   - Anthropic error format
 *   - OpenAI error format
 *   - Generic "X tokens > Y" format
 *   - Large numbers
 *   - Irrelevant messages → null
 *   - Null/undefined/empty input → null (fail-soft)
 *   - Error objects with .message property
 */

const { parseContextOverflowTokens } = require('../../src/services/errorClassifier');

describe('parseContextOverflowTokens', () => {
  describe('Anthropic format', () => {
    test('parses standard Anthropic overflow message', () => {
      const msg = 'prompt is too long: 210000 tokens > 200000 maximum';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 210000, limitTokens: 200000 });
    });

    test('parses single token variant', () => {
      const msg = 'prompt is too long: 1 token > 200000 maximum';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 1, limitTokens: 200000 });
    });

    test('parses with extra whitespace', () => {
      const msg = 'prompt is too long:  350000  tokens >  200000  maximum';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 350000, limitTokens: 200000 });
    });

    test('case insensitive', () => {
      const msg = 'Prompt Is Too Long: 150000 Tokens > 128000 Maximum';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 150000, limitTokens: 128000 });
    });
  });

  describe('OpenAI format', () => {
    test('parses standard OpenAI overflow message', () => {
      const msg = "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.";
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 130000, limitTokens: 128000 });
    });

    test('parses with different numbers', () => {
      const msg = 'maximum context length is 4096 tokens, however your prompt resulted in 8192 tokens';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 8192, limitTokens: 4096 });
    });

    test('parses with multiline content between', () => {
      const msg = 'maximum context length is 16000 tokens.\nPlease reduce the length.\nYour prompt resulted in 20000 tokens.';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 20000, limitTokens: 16000 });
    });
  });

  describe('Generic "X tokens > Y" format', () => {
    test('parses simple generic format', () => {
      const msg = 'Error: 210000 tokens > 200000';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 210000, limitTokens: 200000 });
    });

    test('parses with "token" singular', () => {
      const msg = '5000 token > 4096';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 5000, limitTokens: 4096 });
    });

    test('generic match with prompt < limit fails the sanity check and returns null', () => {
      expect(parseContextOverflowTokens('Error: 100 tokens > 200')).toBeNull();
    });

    test('generic match with prompt equal to limit fails the sanity check and returns null', () => {
      expect(parseContextOverflowTokens('4096 tokens > 4096')).toBeNull();
    });

    test('sanity check applies to the generic pattern only, not provider-specific ones', () => {
      // Anthropic-specific pattern is trusted as-is even when prompt < limit.
      const msg = 'prompt is too long: 100 tokens > 200 maximum';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 100, limitTokens: 200 });
    });
  });

  describe('Large numbers', () => {
    test('handles very large token counts', () => {
      const msg = 'prompt is too long: 1000000 tokens > 500000 maximum';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 1000000, limitTokens: 500000 });
    });

    test('handles million-scale counts in OpenAI format', () => {
      const msg = 'maximum context length is 2000000 tokens, your messages resulted in 2500000 tokens';
      const result = parseContextOverflowTokens(msg);
      expect(result).toEqual({ promptTokens: 2500000, limitTokens: 2000000 });
    });
  });

  describe('Irrelevant messages return null', () => {
    test('unrelated error message', () => {
      expect(parseContextOverflowTokens('connection timed out')).toBeNull();
    });

    test('rate limit message', () => {
      expect(parseContextOverflowTokens('rate limit exceeded, try again later')).toBeNull();
    });

    test('auth error message', () => {
      expect(parseContextOverflowTokens('invalid API key provided')).toBeNull();
    });

    test('message with "tokens" but no overflow pattern', () => {
      expect(parseContextOverflowTokens('used 5000 tokens for this request')).toBeNull();
    });

    test('message with numbers but no token keyword', () => {
      expect(parseContextOverflowTokens('Error 500: server returned 200 bytes')).toBeNull();
    });
  });

  describe('Null/undefined/empty input (fail-soft)', () => {
    test('null input returns null', () => {
      expect(parseContextOverflowTokens(null)).toBeNull();
    });

    test('undefined input returns null', () => {
      expect(parseContextOverflowTokens(undefined)).toBeNull();
    });

    test('empty string returns null', () => {
      expect(parseContextOverflowTokens('')).toBeNull();
    });

    test('numeric input coerced to string returns null', () => {
      expect(parseContextOverflowTokens(12345)).toBeNull();
    });

    test('boolean input returns null', () => {
      expect(parseContextOverflowTokens(false)).toBeNull();
    });
  });

  describe('Error objects with .message property', () => {
    test('parses from Error object with Anthropic message', () => {
      const err = new Error('prompt is too long: 100000 tokens > 80000 maximum');
      const result = parseContextOverflowTokens(err);
      expect(result).toEqual({ promptTokens: 100000, limitTokens: 80000 });
    });

    test('parses from Error object with OpenAI message', () => {
      const err = new Error('maximum context length is 32000 tokens. Your request resulted in 40000 tokens.');
      const result = parseContextOverflowTokens(err);
      expect(result).toEqual({ promptTokens: 40000, limitTokens: 32000 });
    });

    test('Error object with empty message returns null', () => {
      const err = new Error('');
      expect(parseContextOverflowTokens(err)).toBeNull();
    });

    test('Error object with no message property returns null', () => {
      expect(parseContextOverflowTokens({})).toBeNull();
    });

    test('object with non-matching message returns null', () => {
      expect(parseContextOverflowTokens({ message: 'something else' })).toBeNull();
    });
  });
});
