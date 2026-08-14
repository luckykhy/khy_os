'use strict';

/**
 * sseTruncationSignal.test.js — forced-truncation regression for DESIGN-ARCH-046.
 *
 * Constructs the "强制截断流式输出" exception scenario required by the hard
 * constraint: an Anthropic SSE stream that ends mid-generation WITHOUT any
 * terminal marker (no message_delta.stop_reason, no message_stop). The parser
 * must surface a truncation signal (finishReason='length') instead of coercing
 * to 'end_turn' — that signal routes into the existing continuation recovery,
 * so a half-sentence is never finalized as a complete answer.
 *
 * A clean stream (with terminal markers) must still report its real stop_reason
 * and is unaffected — zero behavioral cost on the normal path.
 *
 * Drives the real parser with a fake Readable; zero network.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

const { parseAnthropicSseStream } = require('../../../src/services/gateway/adapters/_anthropicSseStream');

/** Build a Readable that emits the given SSE text frames then ends. */
function fakeStream(frames) {
  const r = new Readable({ read() {} });
  process.nextTick(() => {
    for (const f of frames) r.push(f);
    r.push(null); // 'end'
  });
  return r;
}

// Minimal valid prelude: message_start → text block with one delta.
function prelude(text) {
  return [
    'data: {"type":"message_start","message":{"model":"claude-x","usage":{"input_tokens":3}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`,
  ];
}

describe('parseAnthropicSseStream — premature close (forced truncation)', () => {
  test('stream ends WITHOUT terminal marker but with content → finishReason=length', async () => {
    // No content_block_stop, no message_delta, no message_stop: socket cut off.
    const stream = fakeStream(prelude('第一段：这是被中断的半截'));
    const result = await parseAnthropicSseStream(stream, null, {});
    assert.equal(result.content, '第一段：这是被中断的半截');
    assert.equal(result.finishReason, 'length', 'truncation surfaced, not masked as end_turn');
  });

  test('clean stream WITH stop_reason=end_turn keeps its real reason', async () => {
    const stream = fakeStream([
      ...prelude('完整回答。'),
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const result = await parseAnthropicSseStream(stream, null, {});
    assert.equal(result.content, '完整回答。');
    assert.equal(result.finishReason, 'end_turn', 'normal path unaffected — zero behavioral cost');
  });

  test('real max_tokens truncation (explicit stop_reason=length) is preserved', async () => {
    const stream = fakeStream([
      ...prelude('被max_tokens截断'),
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":8}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const result = await parseAnthropicSseStream(stream, null, {});
    assert.equal(result.finishReason, 'max_tokens');
  });

  test('premature close with NO content does not fabricate a truncation', async () => {
    // Empty stream end → leave finishReason to the end_turn default; the empty
    // reply is handled by the loop\'s empty-reply auto-retry, not here.
    const stream = fakeStream([
      'data: {"type":"message_start","message":{"model":"claude-x"}}\n\n',
    ]);
    const result = await parseAnthropicSseStream(stream, null, {});
    assert.equal(result.content, '');
    assert.equal(result.finishReason, 'end_turn');
  });
});
