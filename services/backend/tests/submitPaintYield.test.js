'use strict';

/**
 * Tests for the submit-time paint-yield gate (paintYieldEnabled).
 *
 * Symptom fixed: "回车响应太慢了，要等几秒才会显示发送" — the user's message is pushed to
 * the timeline optimistically, but synchronous `<cli> --version` spawnSync probes (and the
 * first-submit cold require of toolUseLoop) freeze the event loop before Ink can flush the
 * paint. _runSubmit now yields one macrotask after the push so the "已发送" frame lands first.
 * This gate decides whether that yield runs; default ON, only 0/false/off/no disables it.
 */

const assert = require('assert');

const FLAG = 'KHY_SUBMIT_PAINT_YIELD';
const MODULE_PATH = '../src/cli/tui/hooks/useQueryBridge';

function load(value) {
  delete process.env[FLAG];
  if (value !== undefined) process.env[FLAG] = value;
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH).paintYieldEnabled;
}

describe('paintYieldEnabled — submit paint-yield gate', () => {
  afterEach(() => { delete process.env[FLAG]; });

  test('enabled by default (flag unset)', () => {
    assert.strictEqual(load()(), true);
  });

  test('disabled via 0/false/off/no (case/space tolerant)', () => {
    for (const v of ['0', 'false', 'off', 'no', ' OFF ', 'False']) {
      assert.strictEqual(load(v)(), false, `value=${JSON.stringify(v)}`);
    }
  });

  test('any other value keeps it enabled', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'anything']) {
      assert.strictEqual(load(v)(), true, `value=${JSON.stringify(v)}`);
    }
  });
});
