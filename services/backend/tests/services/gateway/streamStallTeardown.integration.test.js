'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const ADAPTERS = '../../../src/services/gateway/adapters';
const policy = require(`${ADAPTERS}/streamStallPolicy`);
const { parseOpenAISseStream } = require(`${ADAPTERS}/_openaiSseStream`);
const { parseAnthropicSseStream } = require(`${ADAPTERS}/_anthropicSseStream`);
const { parseResponsesSseStream } = require(`${ADAPTERS}/_responsesSseStream`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PARSERS = [
  ['openai', parseOpenAISseStream],
  ['anthropic', parseAnthropicSseStream],
  ['responses', parseResponsesSseStream],
];

function setGate(v) {
  if (v === undefined) delete process.env.KHY_STREAM_STALL_ABORT;
  else process.env.KHY_STREAM_STALL_ABORT = v;
}

test.afterEach(() => setGate(undefined));

// ── gate ON: a stalled zero-progress stream is actively torn down ────────────
for (const [name, parse] of PARSERS) {
  test(`gate on: ${name} parser tears down a stalled zero-progress stream → timeout reject`, async () => {
    setGate(undefined); // default on
    const s = new PassThrough();
    const p = parse(s, null, {
      enableStaleDetection: true,
      staleOptions: { provider: name, thresholdMs: 30 },
    });
    // Never write any data → goes stale at ~30ms.
    await assert.rejects(p, (err) => {
      assert.ok(policy.isStreamStallError(err) || /stalled/i.test(String(err && err.message)),
        `expected a stream-stall error, got ${err && err.message}`);
      assert.strictEqual(err.errorType, 'timeout');
      return true;
    });
    assert.strictEqual(s.destroyed, true, 'stalled stream should be destroyed');
  });
}

// ── gate OFF: byte-revert — stalled stream is NOT torn down (legacy) ─────────
for (const [name, parse] of PARSERS) {
  test(`gate off: ${name} parser does NOT tear down a stalled stream (byte-revert)`, async () => {
    setGate('off');
    const s = new PassThrough();
    let settled = false;
    const p = parse(s, null, {
      enableStaleDetection: true,
      staleOptions: { provider: name, thresholdMs: 25, onStale: () => {} },
    }).then(() => { settled = true; }, () => { settled = true; });
    await delay(120); // well past the stale threshold
    assert.strictEqual(s.destroyed, false, 'legacy behavior must not destroy the stream');
    assert.strictEqual(settled, false, 'promise should still be pending (no teardown)');
    // cleanup: settle the still-open promise
    s.destroy(new Error('test cleanup'));
    await p;
  });
}

// ── gate ON: partial progress is salvaged, not discarded ────────────────────
test('gate on: openai parser salvages partial content on stall (interrupted=length)', async () => {
  setGate(undefined);
  const s = new PassThrough();
  const p = parseOpenAISseStream(s, null, {
    enableStaleDetection: true,
    staleOptions: { provider: 'openai', thresholdMs: 40 },
  });
  // Stream some content, then go silent → stall → salvage partial.
  s.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
  const r = await p;
  assert.match(r.content, /hello/);
  assert.strictEqual(r.interrupted, true);
  assert.strictEqual(r.finishReason, 'length', 'partial stall should be treated as truncation for continuation');
  assert.strictEqual(s.destroyed, true);
});
