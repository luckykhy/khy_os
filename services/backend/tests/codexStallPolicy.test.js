'use strict';

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../src/services/gateway/codexStallPolicy');

test('classifyStallSeverity: hard for reconnect loops', () => {
  assert.strictEqual(policy.classifyStallSeverity('turn_started_reconnect_loop'), 'hard');
  assert.strictEqual(policy.classifyStallSeverity('thread_started_reconnect_loop'), 'hard');
  assert.strictEqual(policy.classifyStallSeverity('transport_reconnect_before_turn'), 'hard');
});

test('classifyStallSeverity: soft for no-followup / noise', () => {
  assert.strictEqual(policy.classifyStallSeverity('turn_started_no_followup'), 'soft');
  assert.strictEqual(policy.classifyStallSeverity('no_subprocess_output'), 'soft');
  assert.strictEqual(policy.classifyStallSeverity('stderr_only_startup_noise'), 'soft');
});

test('classifyStallSeverity: none for meaningful/unknown/empty', () => {
  assert.strictEqual(policy.classifyStallSeverity('meaningful_progress_seen'), 'none');
  assert.strictEqual(policy.classifyStallSeverity('totally_unknown'), 'none');
  assert.strictEqual(policy.classifyStallSeverity(''), 'none');
  assert.strictEqual(policy.classifyStallSeverity(null), 'none');
});

test('isHardBadStall predicate', () => {
  assert.strictEqual(policy.isHardBadStall('turn_started_reconnect_loop'), true);
  assert.strictEqual(policy.isHardBadStall('no_subprocess_output'), false);
  assert.strictEqual(policy.isHardBadStall(''), false);
});

test('resolveStallCooldownMultiplier escalates by severity', () => {
  assert.strictEqual(policy.resolveStallCooldownMultiplier('turn_started_reconnect_loop'), 3);
  assert.strictEqual(policy.resolveStallCooldownMultiplier('no_subprocess_output'), 1.5);
  assert.strictEqual(policy.resolveStallCooldownMultiplier('meaningful_progress_seen'), 1);
  assert.strictEqual(policy.resolveStallCooldownMultiplier(''), 1);
});

test('shouldEarlyBailOnReconnectLoop: single warning never bails (startup noise)', () => {
  // Mirrors gatewayAdapters.stability.test.js "keeps first-response timeout
  // armed for startup noise" — one reconnect warning must NOT bail.
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 1, meaningfulEvents: 0 }),
    false
  );
});

test('shouldEarlyBailOnReconnectLoop: genuine loop bails at threshold', () => {
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 3, meaningfulEvents: 0 }),
    true
  );
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 5, meaningfulEvents: 0 }, { threshold: 4 }),
    true
  );
});

test('shouldEarlyBailOnReconnectLoop: never bails once model produced progress', () => {
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 9, meaningfulEvents: 1 }),
    false
  );
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 9, lastMeaningfulAt: 123 }),
    false
  );
});

test('shouldEarlyBailOnReconnectLoop: invalid threshold (<2) falls back to default 3', () => {
  // An invalid low threshold must never make it bail on a single startup hiccup.
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 1, meaningfulEvents: 0 }, { threshold: 1 }),
    false
  );
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 2, meaningfulEvents: 0 }, { threshold: 1 }),
    false
  );
  assert.strictEqual(
    policy.shouldEarlyBailOnReconnectLoop({ reconnectWarnings: 3, meaningfulEvents: 0 }, { threshold: 1 }),
    true
  );
});

test('shouldEarlyBailOnReconnectLoop: bad snapshot is safe (no bail)', () => {
  assert.strictEqual(policy.shouldEarlyBailOnReconnectLoop(null), false);
  assert.strictEqual(policy.shouldEarlyBailOnReconnectLoop(undefined), false);
  assert.strictEqual(policy.shouldEarlyBailOnReconnectLoop('nope'), false);
});

test('evaluateSpawnPreflight: blocks on non-writable home', () => {
  const r = policy.evaluateSpawnPreflight({ homeDir: '/tmp/x', homeWritable: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'home_not_writable');
  assert.match(r.reason, /not writable/);
});

test('evaluateSpawnPreflight: passes on writable home (and default)', () => {
  assert.strictEqual(policy.evaluateSpawnPreflight({ homeDir: '/home/u', homeWritable: true }).ok, true);
  assert.strictEqual(policy.evaluateSpawnPreflight({}).ok, true);
});
