'use strict';

// Workstream C — extended-thinking cross-turn continuity.
// 1. The SSE parser must capture structured thinking blocks (thinking+signature)
//    and redacted_thinking (data), not just the flat thinking string.
// 2. buildAssistantContent must PREPEND thinking blocks before text/tool_use,
//    and remain byte-identical to the old output when no thinking blocks exist.

const { Readable } = require('stream');
const { parseAnthropicSseStream } = require('../src/services/gateway/adapters/_anthropicSseStream');
const { buildAssistantContent } = require('../src/services/contentBlockUtils');

function sse(events) {
  // Inline framing: each event is a single `data: <json>` line.
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function streamFrom(text) {
  const r = new Readable({ read() {} });
  // Push in two chunks to exercise buffer reassembly across boundaries.
  const mid = Math.floor(text.length / 2);
  r.push(text.slice(0, mid));
  r.push(text.slice(mid));
  r.push(null);
  return r;
}

describe('parseAnthropicSseStream — thinking blocks', () => {
  test('captures thinking+signature and redacted_thinking', async () => {
    const payload = sse([
      { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me reason.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENCBLOB' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Final answer.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]);

    const result = await parseAnthropicSseStream(streamFrom(payload), null, {});

    expect(result.content).toBe('Final answer.');
    expect(result.thinking).toBe('Let me reason.');
    expect(Array.isArray(result.thinkingBlocks)).toBe(true);
    expect(result.thinkingBlocks).toHaveLength(2);
    expect(result.thinkingBlocks[0]).toEqual({ type: 'thinking', thinking: 'Let me reason.', signature: 'SIG123' });
    expect(result.thinkingBlocks[1]).toEqual({ type: 'redacted_thinking', data: 'ENCBLOB' });
  });

  test('non-thinking stream yields empty thinkingBlocks', async () => {
    const payload = sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
    const result = await parseAnthropicSseStream(streamFrom(payload), null, {});
    expect(result.content).toBe('hi');
    expect(result.thinkingBlocks).toEqual([]);
  });
});

describe('buildAssistantContent — thinking prepend', () => {
  const toolUse = [{ type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }];
  const thinking = [{ type: 'thinking', thinking: 'reasoning', signature: 'SIG' }];

  test('prepends thinking before text and tool_use', () => {
    const out = buildAssistantContent('answer', toolUse, thinking);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]).toEqual({ type: 'thinking', thinking: 'reasoning', signature: 'SIG' });
    expect(out[1]).toEqual({ type: 'text', text: 'answer' });
    expect(out[2]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Read' });
  });

  test('redacted_thinking block is preserved with data', () => {
    const out = buildAssistantContent('x', [], [{ type: 'redacted_thinking', data: 'BLOB' }]);
    expect(out[0]).toEqual({ type: 'redacted_thinking', data: 'BLOB' });
    expect(out[1]).toEqual({ type: 'text', text: 'x' });
  });

  test('drops thinking blocks lacking a signature (cannot be echoed back)', () => {
    const out = buildAssistantContent('x', toolUse, [{ type: 'thinking', thinking: 'unsigned', signature: '' }]);
    // No valid thinking block → first block is the text, then tool_use.
    expect(out[0]).toEqual({ type: 'text', text: 'x' });
    expect(out[1]).toMatchObject({ type: 'tool_use', id: 't1' });
  });

  test('ZERO REGRESSION: no thinking blocks → identical to old (text + tool_use)', () => {
    const withUndefined = buildAssistantContent('answer', toolUse);
    const withEmpty = buildAssistantContent('answer', toolUse, []);
    const expected = [
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } },
    ];
    expect(withUndefined).toEqual(expected);
    expect(withEmpty).toEqual(expected);
  });

  test('ZERO REGRESSION: no tool_use and no thinking → plain string', () => {
    expect(buildAssistantContent('just text')).toBe('just text');
    expect(buildAssistantContent('just text', [], [])).toBe('just text');
  });
});
