'use strict';

const test = require('node:test');
const assert = require('node:assert');

const p = require('../../src/services/completionPushPolicy');

test('isEnabled: opt-in (default off; only 1/true/on/yes)', () => {
  assert.strictEqual(p.isEnabled({}), false);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: '' }), false);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: 'off' }), false);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: '0' }), false);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: '1' }), true);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: 'true' }), true);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: 'ON' }), true);
  assert.strictEqual(p.isEnabled({ KHY_PUSH_ON_DONE: 'yes' }), true);
});

test('minMs: default 60000, parses override, fail-soft', () => {
  assert.strictEqual(p.minMs({}), 60000);
  assert.strictEqual(p.minMs({ KHY_PUSH_ON_DONE_MIN_MS: '5000' }), 5000);
  assert.strictEqual(p.minMs({ KHY_PUSH_ON_DONE_MIN_MS: '0' }), 0);
  assert.strictEqual(p.minMs({ KHY_PUSH_ON_DONE_MIN_MS: 'garbage' }), 60000);
  assert.strictEqual(p.minMs({ KHY_PUSH_ON_DONE_MIN_MS: '-3' }), 60000);
});

test('shouldPushOnCompletion: requires enabled + configured + elapsed>=min', () => {
  const base = { enabled: true, configured: true, elapsedMs: 90000, minMs: 60000 };
  assert.strictEqual(p.shouldPushOnCompletion(base), true);
  assert.strictEqual(p.shouldPushOnCompletion({ ...base, enabled: false }), false);
  assert.strictEqual(p.shouldPushOnCompletion({ ...base, configured: false }), false);
  assert.strictEqual(p.shouldPushOnCompletion({ ...base, elapsedMs: 59999 }), false);
  assert.strictEqual(p.shouldPushOnCompletion({ ...base, elapsedMs: 60000 }), true); // boundary inclusive
  assert.strictEqual(p.shouldPushOnCompletion(null), false);
});

test('humanizeElapsed: deterministic durations', () => {
  assert.strictEqual(p.humanizeElapsed(0), '0s');
  assert.strictEqual(p.humanizeElapsed(5000), '5s');
  assert.strictEqual(p.humanizeElapsed(59999), '59s');
  assert.strictEqual(p.humanizeElapsed(60000), '1m');
  assert.strictEqual(p.humanizeElapsed(90000), '1m30s');
  assert.strictEqual(p.humanizeElapsed(3600000), '1h');
  assert.strictEqual(p.humanizeElapsed(3660000), '1h1m');
  assert.strictEqual(p.humanizeElapsed(-1), '0s');
  assert.strictEqual(p.humanizeElapsed('garbage'), '0s');
});

test('buildCompletionPushMessage: success vs failure, single-source text', () => {
  const ok = p.buildCompletionPushMessage({ elapsedMs: 90000, ok: true, summary: 'all green' });
  assert.match(ok.title, /已完成/);
  assert.match(ok.body, /1m30s/);
  assert.match(ok.body, /all green/);
  assert.strictEqual(ok.priority, 'default');

  const bad = p.buildCompletionPushMessage({ elapsedMs: 12000, ok: false });
  assert.match(bad.title, /失败/);
  assert.match(bad.body, /12s/);
  assert.strictEqual(bad.priority, 'high');

  // default ok when omitted
  assert.match(p.buildCompletionPushMessage({ elapsedMs: 1000 }).title, /已完成/);
});

test('buildCompletionPushMessage: summary flattened + truncated, never multiline-injected', () => {
  const m = p.buildCompletionPushMessage({ elapsedMs: 1000, summary: 'line1\nline2\n   spaced   ' });
  assert.ok(!m.body.includes('line1\nline2'), 'summary newlines collapsed');
  const long = 'x'.repeat(500);
  const m2 = p.buildCompletionPushMessage({ elapsedMs: 1000, summary: long });
  assert.ok(m2.body.length < 300);
});

test('determinism: stable output', () => {
  const a = p.buildCompletionPushMessage({ elapsedMs: 90000, ok: true, summary: 's' });
  const b = p.buildCompletionPushMessage({ elapsedMs: 90000, ok: true, summary: 's' });
  assert.deepStrictEqual(a, b);
});

test('describeCompletionPush: stable self-describe', () => {
  const d = p.describeCompletionPush();
  assert.strictEqual(d.gate, 'KHY_PUSH_ON_DONE');
  assert.strictEqual(d.thresholdEnv, 'KHY_PUSH_ON_DONE_MIN_MS');
  assert.strictEqual(d.defaultMinMs, 60000);
  assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
});
