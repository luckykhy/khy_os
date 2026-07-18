'use strict';

/**
 * Tests for transcriptRepair.js — tool_call / tool_result pairing repair.
 */

let mod;
try {
  mod = require('../../src/services/transcriptRepair');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('transcriptRepair', () => {
  const {
    extractToolCalls,
    repairTranscript,
    validateTranscript,
    ensureCompletePairs,
  } = mod || {};

  test('extractToolCalls finds KHY-format tool calls', () => {
    const content = '我来查一下 【调用行情：600519】 看看结果';
    const calls = extractToolCalls(content);
    expect(calls.length).toBe(1);
    expect(calls[0].action).toBe('行情');
    expect(calls[0].arg).toBe('600519');
  });

  test('extractToolCalls returns empty for plain text', () => {
    const calls = extractToolCalls('No tool calls here');
    expect(calls).toEqual([]);
  });

  test('extractToolCalls handles multiple calls in one message', () => {
    const content = '【调用行情：600519】 然后 【调用K线：000001】';
    const calls = extractToolCalls(content);
    expect(calls.length).toBe(2);
  });

  test('repairTranscript removes orphaned tool results', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'orphaned result' },
      { role: 'assistant', content: 'hello' },
    ];
    const repaired = repairTranscript(messages);
    // The orphaned tool result should be dropped
    expect(repaired.some(m => m.content === 'orphaned result')).toBe(false);
  });

  test('repairTranscript preserves valid tool call/result pairs', () => {
    const messages = [
      { role: 'user', content: 'check stock' },
      { role: 'assistant', content: '我来查 【调用行情：600519】' },
      { role: 'tool', content: '{ "price": 1800 }' },
    ];
    const repaired = repairTranscript(messages);
    expect(repaired.length).toBe(3);
  });

  test('validateTranscript reports orphaned tool results', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'no matching call' },
    ];
    const { valid, issues } = validateTranscript(messages);
    expect(valid).toBe(false);
    expect(issues.some(i => i.includes('orphaned'))).toBe(true);
  });

  test('validateTranscript reports consecutive user messages', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ];
    const { issues } = validateTranscript(messages);
    expect(issues.some(i => i.includes('consecutive user'))).toBe(true);
  });

  test('ensureCompletePairs appends synthetic result for dangling tool calls', () => {
    const messages = [
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: '【调用分析：AAPL】' },
    ];
    const result = ensureCompletePairs(messages);
    expect(result.length).toBe(3);
    expect(result[2].role).toBe('tool');
    expect(result[2].content).toContain('超时');
  });

  test('ensureCompletePairs does nothing when pairs are complete', () => {
    const messages = [
      { role: 'user', content: 'check' },
      { role: 'assistant', content: '【调用行情：600519】' },
      { role: 'tool', content: 'result' },
    ];
    const result = ensureCompletePairs(messages);
    expect(result.length).toBe(3);
  });
});
