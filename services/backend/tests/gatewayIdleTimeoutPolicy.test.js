'use strict';

/**
 * gatewayIdleTimeoutPolicy.test.js — 纯叶子契约。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、launcherTimeoutDefaults 门开=ON_DEFAULTS
 * (idle 60s/hard 180s)/门关=LEGACY_DEFAULTS(idle 20s/hard 45s,逐字节回退)、不变式
 * ON.idle<ON.hard(满足 ai.js:2651 poll 布防条件)、返回值是新对象副本、垃圾/异常输入 fail-soft。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/gatewayIdleTimeoutPolicy'));

test('isEnabled: default ON; CANON off-words disable; other truthy → ON', () => {
  assert.strictEqual(leaf.isEnabled({}), true);
  assert.strictEqual(leaf.isEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.isEnabled({ KHY_GATEWAY_IDLE_TIMEOUT_POLICY: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.isEnabled({ KHY_GATEWAY_IDLE_TIMEOUT_POLICY: 'yes' }), true);
  assert.strictEqual(leaf.isEnabled({ KHY_GATEWAY_IDLE_TIMEOUT_POLICY: '1' }), true);
});

test('launcherTimeoutDefaults: ON → CC-scale (hard 180s / idle 60s)', () => {
  assert.deepStrictEqual(leaf.launcherTimeoutDefaults({}), { hardTimeoutMs: 180000, idleTimeoutMs: 60000 });
  assert.deepStrictEqual(leaf.launcherTimeoutDefaults(undefined), { hardTimeoutMs: 180000, idleTimeoutMs: 60000 });
});

test('launcherTimeoutDefaults: OFF → legacy byte-revert (hard 45s / idle 20s)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      leaf.launcherTimeoutDefaults({ KHY_GATEWAY_IDLE_TIMEOUT_POLICY: off }),
      { hardTimeoutMs: 45000, idleTimeoutMs: 20000 },
      `off=${off}`);
  }
});

test('invariant: ON.idle < ON.hard (satisfies ai.js:2651 poll-arming idle<stall)', () => {
  assert.ok(leaf.ON_DEFAULTS.idleTimeoutMs < leaf.ON_DEFAULTS.hardTimeoutMs);
  assert.ok(leaf.LEGACY_DEFAULTS.idleTimeoutMs < leaf.LEGACY_DEFAULTS.hardTimeoutMs);
  // idle window must be positive for the poll to arm at all.
  assert.ok(leaf.ON_DEFAULTS.idleTimeoutMs > 0);
  assert.ok(leaf.LEGACY_DEFAULTS.idleTimeoutMs > 0);
});

test('launcherTimeoutDefaults: returns a fresh copy (frozen constants not exposed for mutation)', () => {
  const a = leaf.launcherTimeoutDefaults({});
  a.hardTimeoutMs = 1;
  assert.strictEqual(leaf.ON_DEFAULTS.hardTimeoutMs, 180000, 'frozen ON_DEFAULTS unchanged');
  assert.strictEqual(leaf.launcherTimeoutDefaults({}).hardTimeoutMs, 180000, 'next call still pristine');
});

test('fail-soft: garbage env types do not throw; resolve to a valid shape', () => {
  for (const junk of [null, 42, 'str', [], { KHY_GATEWAY_IDLE_TIMEOUT_POLICY: {} }]) {
    const out = leaf.launcherTimeoutDefaults(junk);
    assert.strictEqual(typeof out.hardTimeoutMs, 'number');
    assert.strictEqual(typeof out.idleTimeoutMs, 'number');
    assert.ok(out.idleTimeoutMs < out.hardTimeoutMs);
  }
});
