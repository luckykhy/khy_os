'use strict';

// perfTunables.test — the TUI timer cadence tunables leaf.
// Pure leaf: no IO, deterministic. Covers: defaults, per-knob env overrides,
// garbage rejection (NaN/0/negative/empty string), the KHY_TUI_LOW_POWER
// umbrella, and per-knob env winning over the umbrella.

const test = require('node:test');
const assert = require('node:assert');

const { spinnerFrameMs, heartbeatMs, topicBarAnimMs } = require('../../../src/cli/tui/perfTunables');

test('defaults (env unset): 160 / 2000 / 320', () => {
  assert.equal(spinnerFrameMs({}), 160);
  assert.equal(heartbeatMs({}), 2000);
  assert.equal(topicBarAnimMs({}), 320);
});

test('per-knob env overrides accept any finite positive number', () => {
  assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: '100' }), 100);
  assert.equal(heartbeatMs({ KHY_HEARTBEAT_MS: '1500' }), 1500);
  assert.equal(topicBarAnimMs({ KHY_TOPIC_BAR_ANIM_MS: '250' }), 250);
  // Non-integers are finite positives too — accepted as-is.
  assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: '82.5' }), 82.5);
});

test('garbage values (NaN/0/negative/empty) fall back to defaults', () => {
  for (const v of ['abc', 'NaN', '0', '-50', '', '  ', 'Infinity ms']) {
    assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: v }), 160, `spinner garbage ${JSON.stringify(v)}`);
    assert.equal(heartbeatMs({ KHY_HEARTBEAT_MS: v }), 2000, `heartbeat garbage ${JSON.stringify(v)}`);
    assert.equal(topicBarAnimMs({ KHY_TOPIC_BAR_ANIM_MS: v }), 320, `topicBar garbage ${JSON.stringify(v)}`);
  }
  // Infinity is positive but NOT finite — rejected too.
  assert.equal(spinnerFrameMs({ KHY_SPINNER_FRAME_MS: 'Infinity' }), 160);
});

test('KHY_TUI_LOW_POWER=1 umbrella relaxes all defaults to 320 / 3000 / 640', () => {
  const env = { KHY_TUI_LOW_POWER: '1' };
  assert.equal(spinnerFrameMs(env), 320);
  assert.equal(heartbeatMs(env), 3000);
  assert.equal(topicBarAnimMs(env), 640);
});

test('umbrella is strict "1": other writings do not activate it', () => {
  for (const v of ['true', 'on', 'yes', '0', '']) {
    const env = { KHY_TUI_LOW_POWER: v };
    assert.equal(spinnerFrameMs(env), 160, `umbrella writing ${JSON.stringify(v)}`);
    assert.equal(heartbeatMs(env), 2000);
    assert.equal(topicBarAnimMs(env), 320);
  }
});

test('explicit per-knob env wins over the LOW_POWER umbrella', () => {
  const env = {
    KHY_TUI_LOW_POWER: '1',
    KHY_SPINNER_FRAME_MS: '90',
    KHY_HEARTBEAT_MS: '1200',
    KHY_TOPIC_BAR_ANIM_MS: '200',
  };
  assert.equal(spinnerFrameMs(env), 90);
  assert.equal(heartbeatMs(env), 1200);
  assert.equal(topicBarAnimMs(env), 200);
});

test('garbage per-knob env under the umbrella falls back to the RELAXED default', () => {
  const env = { KHY_TUI_LOW_POWER: '1', KHY_SPINNER_FRAME_MS: 'garbage', KHY_HEARTBEAT_MS: '-1', KHY_TOPIC_BAR_ANIM_MS: '' };
  assert.equal(spinnerFrameMs(env), 320);
  assert.equal(heartbeatMs(env), 3000);
  assert.equal(topicBarAnimMs(env), 640);
});

test('default env argument (process.env) does not throw', () => {
  assert.ok(Number.isFinite(spinnerFrameMs()));
  assert.ok(Number.isFinite(heartbeatMs()));
  assert.ok(Number.isFinite(topicBarAnimMs()));
});
