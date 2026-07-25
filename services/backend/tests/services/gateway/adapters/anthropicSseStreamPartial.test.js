'use strict';

// Integration: _anthropicSseStream preserves already-streamed partial text when
// the socket errors AFTER content (ECONNRESET) — resolving finishReason:'length'
// (→ maxTokensRecovery continuation) instead of rejecting and discarding it.
// Gate OFF byte-reverts to reject; AbortError always rejects.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { parseAnthropicSseStream } = require('../../../../src/services/gateway/adapters/_anthropicSseStream');

// Minimal duplex-ish mock: a Readable-like emitter exposing destroy().
function mockStream() {
  const s = new EventEmitter();
  s.destroy = () => {};
  return s;
}

// Feed two text deltas as Anthropic inline-framed SSE data lines, then fire `errFactory`.
function driveWithError(stream, errFactory) {
  // message_start + content_block_start(text) + two text deltas
  stream.emit('data', Buffer.from('data: {"type":"message_start","message":{"model":"claude","usage":{"input_tokens":3}}}\n\n'));
  stream.emit('data', Buffer.from('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
  stream.emit('data', Buffer.from('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"从前有"}}\n\n'));
  stream.emit('data', Buffer.from('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"座山"}}\n\n'));
  // socket dies mid-stream — no message_delta / message_stop terminal marker
  stream.emit('error', errFactory());
}

function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const prev = {};
  for (const k of keys) { prev[k] = process.env[k]; }
  for (const k of keys) {
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try { return fn(); } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const econnreset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const aborterr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

test('gate ON: ECONNRESET after partial → resolve finishReason:length with accumulated content', async () => {
  await withEnv({ KHY_STREAM_ERROR_PRESERVE: undefined }, async () => {
    const stream = mockStream();
    const p = parseAnthropicSseStream(stream, null, {});
    driveWithError(stream, econnreset);
    const res = await p;
    assert.equal(res.finishReason, 'length', 'truncation surfaced as length → maxTokensRecovery continues');
    assert.equal(res.content, '从前有座山', 'already-streamed partial preserved (not discarded)');
    assert.equal(res.model, 'claude');
  });
});

test('gate OFF: ECONNRESET after partial → reject (byte-revert to original discard)', async () => {
  await withEnv({ KHY_STREAM_ERROR_PRESERVE: '0' }, async () => {
    const stream = mockStream();
    const p = parseAnthropicSseStream(stream, null, {});
    driveWithError(stream, econnreset);
    await assert.rejects(p, /ECONNRESET/);
  });
});

test('AbortError after partial → always reject even gate ON (user intent wins)', async () => {
  await withEnv({ KHY_STREAM_ERROR_PRESERVE: undefined }, async () => {
    const stream = mockStream();
    const p = parseAnthropicSseStream(stream, null, {});
    driveWithError(stream, aborterr);
    await assert.rejects(p, /aborted/i);
  });
});

test('error with NO content → reject (nothing to preserve)', async () => {
  await withEnv({ KHY_STREAM_ERROR_PRESERVE: undefined }, async () => {
    const stream = mockStream();
    const p = parseAnthropicSseStream(stream, null, {});
    stream.emit('error', econnreset()); // never emitted any data
    await assert.rejects(p, /ECONNRESET/);
  });
});

test('clean stream still resolves end_turn (no behavioral change on happy path)', async () => {
  const stream = mockStream();
  const p = parseAnthropicSseStream(stream, null, {});
  stream.emit('data', Buffer.from('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
  stream.emit('data', Buffer.from('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'));
  stream.emit('data', Buffer.from('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'));
  stream.emit('data', Buffer.from('data: {"type":"message_stop"}\n\n'));
  stream.emit('end');
  const res = await p;
  assert.equal(res.finishReason, 'end_turn');
  assert.equal(res.content, 'hi');
});
