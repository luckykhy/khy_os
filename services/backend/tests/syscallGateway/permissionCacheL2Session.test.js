'use strict';

/**
 * permissionCacheL2Session.test.js — L2 会话免审（用户知情决定，经门控 KHY_L2_SESSION_ALLOW
 * 可逆、仅内存）的单元契约。覆盖:门控开生效、clear 清零、门控关 no-op+恒 false、L2 与 L1 物理隔离。
 */

const test = require('node:test');
const assert = require('node:assert');

const SUT = '../../src/services/syscallGateway/permissionCache';
const { LEVELS } = require('../../src/services/syscallGateway/resourceClassifier');

function fresh() {
  delete require.cache[require.resolve(SUT)];
  return require(SUT);
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const intent = (action, scope) => ({ action, scope });

test('isL2SessionAllowEnabled: 默认开,仅 0/false/off/no 关', () => {
  const { isL2SessionAllowEnabled } = fresh();
  assert.equal(isL2SessionAllowEnabled({}), true);
  assert.equal(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: 'true' }), true);
  assert.equal(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: '1' }), true);
  assert.equal(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: '' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(isL2SessionAllowEnabled({ KHY_L2_SESSION_ALLOW: v }), false, `${v} 应关`);
  }
});

test('门控开:grantL2SessionExempt 授予 + hasL2SessionExempt 命中(同类)', () => {
  withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, () => {
    const { PermissionCache } = fresh();
    const c = new PermissionCache();
    const it = intent('delete', 'system');
    assert.equal(c.hasL2SessionExempt(it), false, '授予前不命中');
    assert.equal(c.grantL2SessionExempt(it), true, '门控开授予成功');
    assert.equal(c.hasL2SessionExempt(it), true, '授予后同类命中');
    // 不同类(action/scope 任一不同)不命中。
    assert.equal(c.hasL2SessionExempt(intent('delete', 'project')), false);
    assert.equal(c.hasL2SessionExempt(intent('format', 'system')), false);
  });
});

test('门控关:grantL2SessionExempt no-op 且 hasL2SessionExempt 恒 false(红线铁律)', () => {
  withEnv({ KHY_L2_SESSION_ALLOW: 'off' }, () => {
    const { PermissionCache } = fresh();
    const c = new PermissionCache();
    const it = intent('delete', 'system');
    assert.equal(c.grantL2SessionExempt(it), false, '门控关授予为 no-op 返回 false');
    assert.equal(c.hasL2SessionExempt(it), false, '门控关恒 false');
  });
});

test('clear() 清零 L2 会话免审', () => {
  withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, () => {
    const { PermissionCache } = fresh();
    const c = new PermissionCache();
    const it = intent('delete', 'system');
    c.grantL2SessionExempt(it);
    assert.equal(c.hasL2SessionExempt(it), true);
    c.clear();
    assert.equal(c.hasL2SessionExempt(it), false, 'clear 后免审清空');
  });
});

test('L2 与 L1 物理隔离:L2 免审不影响 L1,L1 免审不溢出到 L2', () => {
  withEnv({ KHY_L2_SESSION_ALLOW: 'true' }, () => {
    const { PermissionCache } = fresh();
    const c = new PermissionCache();
    const it = intent('write', 'project');
    // 同 (action, scope) 在 L2 授予,绝不让 L1 的 has 命中(归一键带 level 前缀)。
    c.grantL2SessionExempt(it);
    assert.equal(c.hasSessionExempt(it, LEVELS.L1), false, 'L2 免审不溢出到 L1');
    // 反向:L1 授予不让 L2 命中。
    c.grantSessionExempt(it, LEVELS.L1);
    assert.equal(c.hasL2SessionExempt(it), true, 'L2 仍只看自己的通道');
    assert.equal(c.hasSessionExempt(it, LEVELS.L1), true, 'L1 看自己的通道');
  });
});

test('grantSessionExempt(L1) 维持「非 L1 硬拒」语义不变', () => {
  const { PermissionCache } = fresh();
  const c = new PermissionCache();
  const it = intent('delete', 'system');
  assert.equal(c.grantSessionExempt(it, LEVELS.L2), false, 'L1 通道严禁 L2');
  assert.equal(c.grantSessionExempt(it, LEVELS.L0), false, 'L1 通道严禁 L0');
});
