'use strict';

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../../src/services/gateway/adapters/streamStallPolicy');

// ── gate ─────────────────────────────────────────────────────────────────────
test('isEnabled: default on (undefined env)', () => {
  assert.strictEqual(policy.isEnabled({}), true);
  assert.strictEqual(policy.isEnabled({ KHY_STREAM_STALL_ABORT: undefined }), true);
});

test('isEnabled: only 0/false/off/no (trim/case-insensitive) turn it off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' False ', 'No']) {
    assert.strictEqual(policy.isEnabled({ KHY_STREAM_STALL_ABORT: v }), false, `expected off for ${JSON.stringify(v)}`);
  }
  for (const v of ['1', 'true', 'on', 'yes', 'enabled', '']) {
    assert.strictEqual(policy.isEnabled({ KHY_STREAM_STALL_ABORT: v }), true, `expected on for ${JSON.stringify(v)}`);
  }
});

test('shouldAbortStaleStream tracks the gate (byte-revert when off)', () => {
  assert.strictEqual(policy.shouldAbortStaleStream({}), true);
  assert.strictEqual(policy.shouldAbortStaleStream({ KHY_STREAM_STALL_ABORT: 'off' }), false);
  assert.strictEqual(policy.shouldAbortStaleStream({ KHY_STREAM_STALL_ABORT: '0' }), false);
});

// ── buildStallError ──────────────────────────────────────────────────────────
test('buildStallError: classifies as timeout — message carries stalled + idle timeout', () => {
  const err = policy.buildStallError({ provider: 'openai', elapsedMs: 45000 });
  assert.ok(err instanceof Error);
  // The gateway _errorClassifiers maps "timed out / stalled" → timeout (transient,
  // excluded from circuit). Defense in depth: both the message AND the tag say timeout.
  assert.match(err.message, /stalled/i);
  assert.match(err.message, /idle timeout/i);
  assert.match(err.message, /45s/);
  assert.match(err.message, /openai/);
  assert.strictEqual(err.errorType, 'timeout');
});

test('buildStallError: structured markers for tag-based detection', () => {
  const err = policy.buildStallError({ provider: 'Claude', elapsedMs: 90000 });
  assert.strictEqual(err.name, 'StreamStallError');
  assert.strictEqual(err.code, policy.STREAM_STALL_MARKER);
  assert.strictEqual(err.isStreamStall, true);
  assert.strictEqual(err.stallProvider, 'claude'); // normalized lowercase
  assert.strictEqual(err.stallElapsedMs, 90000);
});

test('buildStallError: junk / missing elapsed → 0s, never throws', () => {
  for (const bad of [undefined, null, NaN, -5, 'abc', {}, Infinity]) {
    const err = policy.buildStallError({ provider: 'x', elapsedMs: bad });
    assert.match(err.message, /no data for 0s/);
    assert.strictEqual(err.stallElapsedMs, 0);
  }
});

test('buildStallError: missing provider → default, empty opts ok', () => {
  const err = policy.buildStallError();
  assert.match(err.message, /from default/);
  assert.strictEqual(err.stallProvider, 'default');
  assert.strictEqual(err.errorType, 'timeout');
});

// ── isStreamStallError ───────────────────────────────────────────────────────
test('isStreamStallError: round-trips on our own error', () => {
  const err = policy.buildStallError({ provider: 'gpt', elapsedMs: 1000 });
  assert.strictEqual(policy.isStreamStallError(err), true);
});

test('isStreamStallError: detects via any single marker', () => {
  assert.strictEqual(policy.isStreamStallError({ code: policy.STREAM_STALL_MARKER }), true);
  assert.strictEqual(policy.isStreamStallError({ isStreamStall: true }), true);
  assert.strictEqual(policy.isStreamStallError({ name: 'StreamStallError' }), true);
});

test('isStreamStallError: false on unrelated / junk', () => {
  for (const bad of [null, undefined, 0, '', 'stall', new Error('econnreset'), { name: 'AbortError' }]) {
    assert.strictEqual(policy.isStreamStallError(bad), false);
  }
});

// ── describeStallPolicy ──────────────────────────────────────────────────────
test('describeStallPolicy: reflects gate state', () => {
  const on = policy.describeStallPolicy({});
  assert.strictEqual(on.enabled, true);
  assert.strictEqual(on.gate, 'KHY_STREAM_STALL_ABORT');
  assert.match(on.behaviorWhenStale, /tear down/i);

  const off = policy.describeStallPolicy({ KHY_STREAM_STALL_ABORT: 'off' });
  assert.strictEqual(off.enabled, false);
  assert.match(off.behaviorWhenStale, /legacy/i);
});

// ── determinism / never-throws ───────────────────────────────────────────────
test('deterministic + never throws on hostile inputs', () => {
  assert.doesNotThrow(() => policy.isEnabled(null));
  assert.doesNotThrow(() => policy.shouldAbortStaleStream(undefined));
  assert.doesNotThrow(() => policy.buildStallError({ provider: { toString() { throw new Error('x'); } } }));
  assert.doesNotThrow(() => policy.isStreamStallError(Symbol('s')));
});
