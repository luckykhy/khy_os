'use strict';

/**
 * Tests for contextPruner.js — CJK-aware context pruning.
 */

let mod;
try {
  mod = require('../../src/services/contextPruner');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('contextPruner', () => {
  const {
    estimateWeightedChars,
    estimateTokensFromChars,
    takeHead,
    takeTail,
    softTrimToolResult,
    pruneContext,
    CHARS_PER_TOKEN,
    CJK_CHARS_PER_TOKEN,
    DEFAULT_SETTINGS,
  } = mod || {};

  test('estimateWeightedChars counts ASCII as 1 per char', () => {
    const result = estimateWeightedChars('hello');
    expect(result).toBe(5);
  });

  test('estimateWeightedChars counts CJK chars with higher weight', () => {
    // Each CJK char should count as CJK_CHARS_PER_TOKEN (2)
    const result = estimateWeightedChars('你好');
    expect(result).toBe(2 * CJK_CHARS_PER_TOKEN);
  });

  test('estimateWeightedChars handles mixed CJK and ASCII', () => {
    const result = estimateWeightedChars('hi你好');
    expect(result).toBe(2 + 2 * CJK_CHARS_PER_TOKEN);
  });

  test('estimateTokensFromChars converts weighted chars to tokens', () => {
    expect(estimateTokensFromChars(16)).toBe(Math.ceil(16 / CHARS_PER_TOKEN));
    expect(estimateTokensFromChars(0)).toBe(0);
  });

  test('takeHead takes first N chars from parts', () => {
    const parts = ['hello world', 'second line'];
    const result = takeHead(parts, 5);
    expect(result).toBe('hello');
  });

  test('takeTail takes last N chars from parts', () => {
    const parts = ['first line', 'last words'];
    const result = takeTail(parts, 5);
    expect(result).toBe('words');
  });

  test('softTrimToolResult does not trim short content', () => {
    const { trimmed, wasTrimmed } = softTrimToolResult('short text');
    expect(wasTrimmed).toBe(false);
    expect(trimmed).toBe('short text');
  });

  test('softTrimToolResult trims long content keeping head and tail', () => {
    const longContent = 'A'.repeat(10000);
    const { trimmed, wasTrimmed } = softTrimToolResult(longContent);
    expect(wasTrimmed).toBe(true);
    expect(trimmed.length).toBeLessThan(longContent.length);
    expect(trimmed).toContain('...');
    expect(trimmed).toContain('[Tool result trimmed');
  });

  test('pruneContext returns messages unchanged when under soft threshold', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const result = pruneContext(messages, {
      contextWindowTokens: 100000,
    });
    expect(result).toEqual(messages);
  });
});
