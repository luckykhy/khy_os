'use strict';

// Integration: the seamless-resume budget floor is actually consumed by
// toolUseLoop._resolveTransientRecoveryMax — gate ON raises small/normal,
// gate OFF byte-reverts to 0/1/3, and explicit env/options overrides still win.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const loop = require('../../src/services/toolUseLoop');
const resolve = loop._resolveTransientRecoveryMax;

// taskScale override lets us pin the scale deterministically.
const small = (opts = {}) => resolve('hi', { taskScale: 'small', ...opts });
const normal = (opts = {}) => resolve('hi', { taskScale: 'normal', ...opts });
const large = (opts = {}) => resolve('hi', { taskScale: 'large', ...opts });

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

const CLEAR = {
  KHY_SEAMLESS_RESUME: undefined,
  KHY_TOOL_LOOP_TRANSIENT_RECOVERIES: undefined,
  KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_SMALL: undefined,
  KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_LARGE: undefined,
};

test('gate ON (default): small/normal get a non-zero seamless floor', () => {
  withEnv(CLEAR, () => {
    assert.equal(small(), 1, 'small task now auto-resumes ≥1 (was 0 — the reported gap)');
    assert.equal(normal(), 2);
    assert.equal(large(), 3);
  });
});

test('gate OFF: byte-revert to historical 0/1/3', () => {
  withEnv({ ...CLEAR, KHY_SEAMLESS_RESUME: '0' }, () => {
    assert.equal(small(), 0);
    assert.equal(normal(), 1);
    assert.equal(large(), 3);
  });
});

test('explicit env override wins over the gate floor (can force small back to 0)', () => {
  withEnv({ ...CLEAR, KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_SMALL: '0' }, () => {
    assert.equal(small(), 0, 'explicit 0 still forces 0 even with gate on');
  });
  withEnv({ ...CLEAR, KHY_TOOL_LOOP_TRANSIENT_RECOVERIES: '4' }, () => {
    assert.equal(normal(), 4, 'explicit normal override honored (clamped to ≤4)');
  });
  withEnv({ ...CLEAR, KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_LARGE: '6' }, () => {
    assert.equal(large(), 6);
  });
});

test('options.maxTransientRecoveries is highest priority and clamped to [0,6]', () => {
  withEnv(CLEAR, () => {
    assert.equal(small({ maxTransientRecoveries: 5 }), 5);
    assert.equal(normal({ maxTransientRecoveries: 99 }), 6);
    assert.equal(large({ maxTransientRecoveries: -3 }), 0);
  });
});

test('env clamps preserved: small ≤3, normal ≤4, large ≤6', () => {
  withEnv({ ...CLEAR, KHY_TOOL_LOOP_TRANSIENT_RECOVERIES_SMALL: '99' }, () => {
    assert.equal(small(), 3);
  });
  withEnv({ ...CLEAR, KHY_TOOL_LOOP_TRANSIENT_RECOVERIES: '99' }, () => {
    assert.equal(normal(), 4);
  });
});
