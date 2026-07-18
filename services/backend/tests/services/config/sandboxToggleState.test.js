'use strict';

/**
 * sandboxToggleState.test.js — 纯叶子 `/sandbox-toggle` 逻辑契约(node:test,零 IO)。
 *
 * 锁定:normalizeSandboxFlag(true/false/auto 别名 + 无法识别);resolveSandboxState(复刻
 * isOsSandboxEnabled:flag=false 必关、auto/true 按平台可用性、各平台后端);planSandboxAction
 * (on/off/auto-unset/toggle 基于当前生效语义翻转、未知动作报错);门控梯。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSandboxFlag,
  resolveSandboxState,
  planSandboxAction,
  isEnabled,
} = require('../../../src/services/config/sandboxToggleState');

describe('normalizeSandboxFlag', () => {
  test('true 别名', () => {
    for (const v of ['true', 'on', '1', 'yes', 'enable', 'ENABLED']) {
      assert.equal(normalizeSandboxFlag(v), 'true', v);
    }
  });
  test('false 别名', () => {
    for (const v of ['false', 'off', '0', 'no', 'disable', 'DISABLED']) {
      assert.equal(normalizeSandboxFlag(v), 'false', v);
    }
  });
  test('auto(含空串/default)', () => {
    for (const v of ['auto', 'AUTO', 'default', '', '  ']) {
      assert.equal(normalizeSandboxFlag(v), 'auto', JSON.stringify(v));
    }
  });
  test('无法识别 → 空串', () => {
    assert.equal(normalizeSandboxFlag('bogus'), '');
    assert.equal(normalizeSandboxFlag(null), 'auto'); // null → '' → auto
  });
});

describe('resolveSandboxState — 复刻 isOsSandboxEnabled', () => {
  test('flag=false → 恒关(即便后端可用)', () => {
    const s = resolveSandboxState({ flag: 'false', platform: 'linux', bwrapAvailable: true });
    assert.equal(s.effective, false);
    assert.equal(s.backend, 'bubblewrap');
    assert.match(s.reason, /关闭/);
  });
  test('linux auto + bwrap 可用 → 生效', () => {
    const s = resolveSandboxState({ flag: 'auto', platform: 'linux', bwrapAvailable: true });
    assert.equal(s.effective, true);
    assert.equal(s.backend, 'bubblewrap');
    assert.equal(s.available, true);
  });
  test('linux auto + bwrap 不可用 → 不生效', () => {
    const s = resolveSandboxState({ flag: 'auto', platform: 'linux', bwrapAvailable: false });
    assert.equal(s.effective, false);
    assert.equal(s.available, false);
    assert.match(s.reason, /bubblewrap/);
  });
  test('darwin + seatbelt 可用 → 生效', () => {
    const s = resolveSandboxState({ flag: 'true', platform: 'darwin', seatbeltAvailable: true });
    assert.equal(s.effective, true);
    assert.equal(s.backend, 'seatbelt');
  });
  test('win32 → 后端始终可用', () => {
    const s = resolveSandboxState({ flag: 'auto', platform: 'win32' });
    assert.equal(s.effective, true);
    assert.equal(s.backend, 'job-object');
    assert.equal(s.available, true);
  });
  test('未知平台 → 无后端、不生效', () => {
    const s = resolveSandboxState({ flag: 'true', platform: 'sunos' });
    assert.equal(s.backend, 'none');
    assert.equal(s.effective, false);
    assert.match(s.reason, /无 OS 沙箱后端/);
  });
  test('flag 缺省 → 当 auto', () => {
    const s = resolveSandboxState({ platform: 'win32' });
    assert.equal(s.flag, 'auto');
  });
  test('防呆:空入参不抛', () => {
    assert.equal(typeof resolveSandboxState().effective, 'boolean');
  });
});

describe('planSandboxAction', () => {
  test('on → 写 true', () => {
    assert.deepEqual(planSandboxAction('on', 'auto'), { ok: true, flag: 'true', parseError: null });
  });
  test('off → 写 false', () => {
    assert.deepEqual(planSandboxAction('off', 'auto'), { ok: true, flag: 'false', parseError: null });
  });
  test('auto → unset(回默认)', () => {
    const r = planSandboxAction('auto', 'true');
    assert.equal(r.ok, true);
    assert.equal(r.unset, true);
  });
  test('toggle:当前 false → 开', () => {
    assert.equal(planSandboxAction('toggle', 'false').flag, 'true');
  });
  test('toggle:当前 auto → 关(off 总显式)', () => {
    assert.equal(planSandboxAction('toggle', 'auto').flag, 'false');
  });
  test('toggle:当前 true → 关', () => {
    assert.equal(planSandboxAction('toggle', 'true').flag, 'false');
  });
  test('空动作 → 当 toggle', () => {
    assert.equal(planSandboxAction('', 'false').flag, 'true');
  });
  test('未知动作 → parseError', () => {
    const r = planSandboxAction('frobnicate', 'auto');
    assert.equal(r.ok, false);
    assert.match(r.parseError, /未知动作/);
  });
});

describe('门控 isEnabled', () => {
  test('默认 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: v }), false);
    }
  });
});
