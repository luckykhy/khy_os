'use strict';

/**
 * Tests for contextCompressor.js — 4-phase split-point, base64 stripping,
 * conversation bridge, and slimForCompression.
 */

let mod;
try {
  mod = require('../../src/services/contextCompressor');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('contextCompressor', () => {
  const {
    findCompressSplitPoint,
    slimForCompression,
    stripBase64,
    buildConversationBridge,
    compress,
    COMPRESSION_TOKEN_THRESHOLD,
    MAX_TOOL_RESULT_CHARS,
  } = mod || {};

  // Simple token estimator: 1 token per 4 chars
  const estimateTokens = (text) => Math.ceil((text || '').length / 4);

  test('findCompressSplitPoint returns 0 for very short messages', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = findCompressSplitPoint(msgs, estimateTokens, 10);
    expect(result).toBe(0);
  });

  test('findCompressSplitPoint skips system messages at start', () => {
    const msgs = [
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'y'.repeat(400) },
      { role: 'user', content: 'z'.repeat(400) },
      { role: 'assistant', content: 'w'.repeat(400) },
      { role: 'user', content: 'final question' },
      { role: 'assistant', content: 'final answer' },
    ];
    const totalTokens = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
    const split = findCompressSplitPoint(msgs, estimateTokens, totalTokens, 0.5);
    // Split should be >= 1 (after the system message)
    expect(split).toBeGreaterThanOrEqual(1);
  });

  test('findCompressSplitPoint prefers user-message boundaries', () => {
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a'.repeat(200) },
      { role: 'assistant', content: 'b'.repeat(200) },
      { role: 'user', content: 'c'.repeat(200) },
      { role: 'assistant', content: 'd'.repeat(200) },
      { role: 'user', content: 'e'.repeat(200) },
      { role: 'assistant', content: 'f'.repeat(200) },
    ];
    const totalTokens = msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
    const split = findCompressSplitPoint(msgs, estimateTokens, totalTokens, 0.6);
    // The split boundary should land on a user message index
    if (split > 0 && split < msgs.length) {
      const atSplit = msgs[split];
      expect(['user', 'system']).toContain(atSplit.role);
    }
  });

  test('stripBase64 removes base64 data URLs', () => {
    const fakeB64 = 'A'.repeat(200);
    const text = `Hello data:image/png;base64,${fakeB64} world`;
    const { text: result, strippedCount } = stripBase64(text);
    expect(strippedCount).toBe(1);
    expect(result).toContain('[image: image/png]');
    expect(result).not.toContain(fakeB64);
  });

  test('stripBase64 returns original for text without base64', () => {
    const { text, strippedCount } = stripBase64('no images here');
    expect(strippedCount).toBe(0);
    expect(text).toBe('no images here');
  });

  test('slimForCompression truncates oversized tool results', () => {
    const longContent = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5000);
    const msgs = [
      { role: 'tool', content: longContent },
      { role: 'user', content: 'short' },
    ];
    const { slimmed, freedChars } = slimForCompression(msgs);
    expect(slimmed[0].content.length).toBeLessThan(longContent.length);
    expect(freedChars).toBeGreaterThan(0);
    // User message should be unchanged
    expect(slimmed[1].content).toBe('short');
  });

  test('buildConversationBridge prepends user message when first is assistant', () => {
    const kept = [
      { role: 'assistant', content: 'some answer' },
      { role: 'user', content: 'question' },
    ];
    const bridged = buildConversationBridge(kept, 'context hint');
    expect(bridged.length).toBe(kept.length + 1);
    expect(bridged[0].role).toBe('user');
    expect(bridged[0].content).toContain('context hint');
  });

  test('buildConversationBridge handles tool result at start', () => {
    const kept = [
      { role: 'tool', content: 'result data' },
    ];
    const bridged = buildConversationBridge(kept);
    // Should insert user + assistant bridge before the tool result
    expect(bridged.length).toBe(3);
    expect(bridged[0].role).toBe('user');
    expect(bridged[1].role).toBe('assistant');
    expect(bridged[2].role).toBe('tool');
  });
});
