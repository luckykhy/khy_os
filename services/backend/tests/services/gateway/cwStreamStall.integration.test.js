'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ADAPTERS = '../../../src/services/gateway/adapters';
const policy = require(`${ADAPTERS}/streamStallPolicy`);
const { parseCWStreamEvents } = require(`${ADAPTERS}/_cwStreamParser`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function setGate(v) {
  if (v === undefined) delete process.env.KHY_STREAM_STALL_ABORT;
  else process.env.KHY_STREAM_STALL_ABORT = v;
}

test.afterEach(() => setGate(undefined));

// An async-iterable CW event stream. Yields the provided events with `gapMs`
// between each, then — if `stallForeverAfter` is set — blocks indefinitely
// (simulating an upstream that stops sending without closing the iterator).
function makeCWStream({ events = [], gapMs = 5, stallForever = false }) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const ev of events) {
        await delay(gapMs);
        yield ev;
      }
      if (stallForever) {
        // Block "forever" via an unref'd timer so the consumer must tear us down
        // on stall, yet the test process can still exit (gate-off legacy path
        // stays suspended here by design — no teardown).
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 600000);
          if (t.unref) t.unref();
        });
      }
    },
  };
}

const textEvent = (text) => ({ assistantResponseEvent: { content: text, modelId: 'claude-x' } });

// ── gate ON: zero-progress stall → throws a timeout-classified stall error ──
test('gate on: CW parser throws stall error on a zero-progress stalled stream', async () => {
  setGate(undefined); // default on
  const stream = makeCWStream({ events: [], stallForever: true });
  await assert.rejects(
    parseCWStreamEvents(stream, null, {
      enableStaleDetection: true,
      staleOptions: { provider: 'claude', thresholdMs: 30 },
    }),
    (err) => {
      assert.ok(policy.isStreamStallError(err), `expected a stream-stall error, got ${err && err.message}`);
      assert.strictEqual(err.errorType, 'timeout');
      return true;
    },
  );
});

// ── gate ON: partial progress → resolves the salvaged partial (interrupted) ──
test('gate on: CW parser salvages partial content on stall (interrupted=length)', async () => {
  setGate(undefined);
  const stream = makeCWStream({ events: [textEvent('hello ')], gapMs: 2, stallForever: true });
  const r = await parseCWStreamEvents(stream, null, {
    enableStaleDetection: true,
    staleOptions: { provider: 'claude', thresholdMs: 40 },
  });
  assert.match(r.content, /hello/);
  assert.strictEqual(r.interrupted, true);
  assert.strictEqual(r.finishReason, 'length');
});

// ── gate OFF: byte-revert — no teardown, the stalled stream is NOT salvaged ──
test('gate off: CW parser does NOT tear down a stalled stream (byte-revert)', async () => {
  setGate('off');
  const stream = makeCWStream({ events: [textEvent('partial')], gapMs: 2, stallForever: true });
  let settled = false;
  const p = parseCWStreamEvents(stream, null, {
    enableStaleDetection: true,
    staleOptions: { provider: 'claude', thresholdMs: 25 },
  }).then(() => { settled = true; }, () => { settled = true; });
  await delay(120); // well past the stale threshold
  assert.strictEqual(settled, false, 'legacy path must keep waiting (no stall teardown)');
});

// ── a clean stream still completes normally with stale detection enabled ──
test('gate on: CW parser completes a healthy stream normally', async () => {
  setGate(undefined);
  const stream = makeCWStream({ events: [textEvent('a'), textEvent('b'), textEvent('c')], gapMs: 2 });
  const r = await parseCWStreamEvents(stream, null, {
    enableStaleDetection: true,
    staleOptions: { provider: 'claude', thresholdMs: 5000 },
  });
  assert.strictEqual(r.content, 'abc');
  assert.strictEqual(r.interrupted, undefined);
  assert.strictEqual(r.modelId, 'claude-x');
});

// ── no opt-in → legacy for-await path regardless of gate ──
test('no opt-in: CW parser uses the legacy path and completes normally', async () => {
  setGate(undefined);
  const stream = makeCWStream({ events: [textEvent('x'), textEvent('y')], gapMs: 2 });
  const r = await parseCWStreamEvents(stream, null, {});
  assert.strictEqual(r.content, 'xy');
});

// ── tool_use blocks are flushed on stall salvage ──
test('gate on: CW parser flushes open tool_use blocks on stall salvage', async () => {
  setGate(undefined);
  const events = [
    { toolUseEvent: { toolUseId: 't1', name: 'do_it', input: '{"a":1}' } },
  ];
  const stream = makeCWStream({ events, gapMs: 2, stallForever: true });
  const r = await parseCWStreamEvents(stream, null, {
    enableStaleDetection: true,
    staleOptions: { provider: 'claude', thresholdMs: 40 },
  });
  assert.strictEqual(r.interrupted, true);
  assert.strictEqual(r.toolUseBlocks.length, 1);
  assert.strictEqual(r.toolUseBlocks[0].name, 'do_it');
  assert.deepStrictEqual(r.toolUseBlocks[0].input, { a: 1 });
});
