'use strict';

const {
  repairTranscript,
  repairRoleAlternation,
  validateTranscript,
  ensureCompletePairs,
  extractToolCalls,
} = require('../../src/services/transcriptRepair');

describe('transcriptRepair', () => {
  describe('extractToolCalls', () => {
    test('extracts single tool call', () => {
      const result = extractToolCalls('【调用行情：600519】');
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('行情');
      expect(result[0].arg).toBe('600519');
    });

    test('extracts multiple tool calls', () => {
      const result = extractToolCalls('【调用行情：600519】【调用搜索：test】');
      expect(result).toHaveLength(2);
      expect(result[0].action).toBe('行情');
      expect(result[1].action).toBe('搜索');
    });

    test('returns empty for no matches', () => {
      const result = extractToolCalls('no tool calls here');
      expect(result).toHaveLength(0);
    });

    test('returns empty for null/undefined', () => {
      expect(extractToolCalls(null)).toHaveLength(0);
      expect(extractToolCalls(undefined)).toHaveLength(0);
    });

    test('handles multiline args', () => {
      const result = extractToolCalls('【调用命令：ls\n-la】');
      expect(result).toHaveLength(1);
      expect(result[0].action).toBe('命令');
    });
  });

  describe('repairTranscript', () => {
    test('returns empty for empty array', () => {
      expect(repairTranscript([])).toEqual([]);
    });

    test('returns empty for null', () => {
      expect(repairTranscript(null)).toEqual([]);
    });

    test('preserves system messages', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant' },
      ];
      const result = repairTranscript(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('system');
    });

    test('preserves user messages', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
      ];
      const result = repairTranscript(messages);
      expect(result).toHaveLength(1);
    });

    test('preserves valid tool result', () => {
      const messages = [
        { role: 'assistant', content: '【调用行情：600519】' },
        { role: 'tool', content: 'result data' },
      ];
      const result = repairTranscript(messages);
      expect(result).toHaveLength(2);
    });

    test('removes orphaned tool result', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'tool', content: 'orphaned result' },
      ];
      const result = repairTranscript(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
    });

    test('keeps tool result after assistant without tool call', () => {
      const messages = [
        { role: 'assistant', content: 'no tool call' },
        { role: 'tool', content: 'result' },
      ];
      const result = repairTranscript(messages);
      expect(result).toHaveLength(2);
    });

    test('handles multiple tool calls', () => {
      const messages = [
        { role: 'assistant', content: '【调用A：1】【调用B：2】' },
        { role: 'tool', content: 'result A' },
        { role: 'tool', content: 'result B' },
      ];
      const result = repairTranscript(messages);
      expect(result).toHaveLength(3);
    });
  });

  describe('validateTranscript', () => {
    test('returns invalid for non-array', () => {
      const result = validateTranscript(null);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('messages is not an array');
    });

    test('returns valid for empty array', () => {
      const result = validateTranscript([]);
      expect(result.valid).toBe(true);
    });

    test('detects orphaned tool result', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'tool', content: 'orphaned' },
      ];
      const result = validateTranscript(messages);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('orphaned'))).toBe(true);
    });

    test('detects consecutive user messages', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'World' },
      ];
      const result = validateTranscript(messages);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('consecutive'))).toBe(true);
    });

    test('detects pending tool calls at end', () => {
      const messages = [
        { role: 'assistant', content: '【调用A：1】' },
      ];
      const result = validateTranscript(messages);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('without results'))).toBe(true);
    });

    test('returns valid for correct sequence', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '【调用A：1】' },
        { role: 'tool', content: 'result' },
        { role: 'assistant', content: 'Done' },
      ];
      const result = validateTranscript(messages);
      expect(result.valid).toBe(true);
    });
  });

  describe('ensureCompletePairs', () => {
    test('returns empty for empty array', () => {
      expect(ensureCompletePairs([])).toEqual([]);
    });

    test('returns empty for null', () => {
      expect(ensureCompletePairs(null)).toEqual([]);
    });

    test('appends missing tool results', () => {
      const messages = [
        { role: 'assistant', content: '【调用A：1】【调用B：2】' },
        { role: 'tool', content: 'result A' },
      ];
      const result = ensureCompletePairs(messages);
      expect(result).toHaveLength(3);
      expect(result[2].role).toBe('tool');
      expect(result[2].content).toContain('超时');
    });

    test('does not modify complete pairs', () => {
      const messages = [
        { role: 'assistant', content: '【调用A：1】' },
        { role: 'tool', content: 'result A' },
      ];
      const result = ensureCompletePairs(messages);
      expect(result).toHaveLength(2);
    });

    test('stops at last user message', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '【调用A：1】' },
        { role: 'user', content: 'World' },
      ];
      const result = ensureCompletePairs(messages);
      expect(result).toHaveLength(3);
    });
  });

  describe('repairRoleAlternation', () => {
    test('returns empty for empty array', () => {
      expect(repairRoleAlternation([])).toEqual([]);
    });

    test('returns empty for null', () => {
      expect(repairRoleAlternation(null)).toEqual([]);
    });

    test('preserves system messages', () => {
      const messages = [
        { role: 'system', content: 'System prompt' },
      ];
      const result = repairRoleAlternation(messages);
      expect(result).toHaveLength(1);
    });

    test('merges consecutive assistant messages', () => {
      const messages = [
        { role: 'assistant', content: 'First' },
        { role: 'assistant', content: 'Second' },
      ];
      const result = repairRoleAlternation(messages);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('First');
      expect(result[0].content).toContain('Second');
    });

    test('merges consecutive user messages', () => {
      const messages = [
        { role: 'user', content: 'First' },
        { role: 'user', content: 'Second' },
      ];
      const result = repairRoleAlternation(messages);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('First');
      expect(result[0].content).toContain('Second');
    });

    test('inserts synthetic assistant for orphaned tool', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'tool', content: 'orphaned' },
      ];
      const result = repairRoleAlternation(messages);
      expect(result).toHaveLength(3);
      expect(result[1].role).toBe('assistant');
      expect(result[1]._synthetic).toBe(true);
    });

    test('preserves valid sequence', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: '【调用A：1】' },
        { role: 'tool', content: 'result' },
        { role: 'assistant', content: 'Done' },
      ];
      const result = repairRoleAlternation(messages);
      expect(result).toHaveLength(4);
    });
  });
});
