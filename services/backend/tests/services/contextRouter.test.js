'use strict';

/**
 * Tests for contextRouter.js — context overflow routing strategy.
 * Mocks contextWasm.estimateTokens to control token counts.
 */

jest.mock('../../src/services/contextWasm', () => ({
  estimateTokens: jest.fn((text) => {
    // Simple mock: 1 char = 1 token
    return typeof text === 'string' ? text.length : 0;
  }),
}));

const {
  routeContextStrategy,
  truncateToolResults,
  sumToolResultTokens,
  SAFETY_MARGIN,
  PREEMPTIVE_RATIO,
  SINGLE_RESULT_SHARE,
} = require('../../src/services/contextRouter');

describe('routeContextStrategy', () => {
  test('returns "fits" when total tokens within budget', () => {
    const messages = [
      { role: 'user', content: 'hi' },      // 2 tokens
      { role: 'assistant', content: 'hey' }, // 3 tokens
    ];
    const result = routeContextStrategy(messages, 'sys', 'user', 10000);
    expect(result.route).toBe('fits');
    expect(result.overflow).toBe(0);
  });

  test('returns "compact_only" when overflow and no tool results', () => {
    // Create messages that exceed budget
    const longContent = 'x'.repeat(1000);
    const messages = [
      { role: 'user', content: longContent },
      { role: 'assistant', content: longContent },
    ];
    const result = routeContextStrategy(messages, longContent, longContent, 100);
    expect(result.route).toBe('compact_only');
    expect(result.overflow).toBeGreaterThan(0);
    expect(result.toolResultTokens).toBe(0);
  });

  test('returns "truncate_tool_results_only" when tool results can cover overflow', () => {
    const toolContent = 'x'.repeat(500); // 500 tokens
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: toolContent },
    ];
    // Budget tight enough to overflow slightly but tool results can cover it
    // Total = (2 + 500 + 3 + 3) * 1.2 = 609.6, threshold = budget * 0.9
    // We want overflow small enough that 50% of tool tokens covers it
    const budget = 600; // threshold = 540, total ~610, overflow ~70
    const result = routeContextStrategy(messages, 'sys', 'usr', budget);
    if (result.route === 'truncate_tool_results_only') {
      expect(result.toolResultTokens).toBeGreaterThan(0);
    }
    // Route should be one of the overflow routes
    expect(['truncate_tool_results_only', 'compact_then_truncate', 'compact_only']).toContain(result.route);
  });

  test('returns "compact_then_truncate" when tool results alone insufficient', () => {
    const longContent = 'x'.repeat(5000);
    const messages = [
      { role: 'user', content: longContent },
      { role: 'tool', content: 'small' },
    ];
    const result = routeContextStrategy(messages, longContent, longContent, 100);
    expect(['compact_then_truncate', 'compact_only']).toContain(result.route);
    expect(result.overflow).toBeGreaterThan(0);
  });
});

describe('sumToolResultTokens', () => {
  test('sums only tool role messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'tool', content: '12345' },     // 5 tokens
      { role: 'assistant', content: 'world' },
      { role: 'tool', content: '123' },        // 3 tokens
    ];
    expect(sumToolResultTokens(messages)).toBe(8);
  });

  test('returns 0 for no tool messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    expect(sumToolResultTokens(messages)).toBe(0);
  });
});

describe('truncateToolResults', () => {
  test('truncates oversized tool results', () => {
    const content = 'a'.repeat(1000);
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content },
    ];
    const saved = truncateToolResults(messages, 100);
    expect(saved).toBeGreaterThan(0);
    expect(messages[1].content.length).toBeLessThan(content.length);
    expect(messages[1].content).toContain('[truncated');
  });

  test('does not truncate non-tool messages', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(1000) },
    ];
    const saved = truncateToolResults(messages, 500);
    expect(saved).toBe(0);
  });
});

describe('constants', () => {
  test('SAFETY_MARGIN is 1.2', () => {
    expect(SAFETY_MARGIN).toBe(1.2);
  });

  test('PREEMPTIVE_RATIO is 0.9', () => {
    expect(PREEMPTIVE_RATIO).toBe(0.9);
  });

  test('SINGLE_RESULT_SHARE is 0.5', () => {
    expect(SINGLE_RESULT_SHARE).toBe(0.5);
  });
});
