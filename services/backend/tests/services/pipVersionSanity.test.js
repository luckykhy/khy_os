'use strict';

const test = require('node:test');
const assert = require('node:assert');

const policy = require('../../src/services/pipFailurePolicy');
const { evaluateUpdatedVersion, isVersionSanityEnabled } = policy;

// 修①版本串包守卫:防止把无关包(khy-quant 1.8.0)的版本冒充成 khy-os 的升级结果。

test('门控默认开', () => {
  assert.strictEqual(isVersionSanityEnabled({}), true);
});

test('门控显式关(off/false/0/no)', () => {
  for (const raw of ['off', 'false', '0', 'no', 'OFF']) {
    assert.strictEqual(isVersionSanityEnabled({ KHY_PIP_VERSION_SANITY: raw }), false, `raw=${raw}`);
  }
});

test('正常小版本升级 → 可信', () => {
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    upgradedPkg: 'khy-os',
    versionPkg: 'khy-os',
    currentVersion: '0.1.187',
    newVersion: '0.1.188',
    env: {},
  });
  assert.strictEqual(r.trusted, true);
});

test('跨包泄漏:版本读自 khy-quant 而目标是 khy-os → 拒绝', () => {
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    upgradedPkg: 'khy-os',
    versionPkg: 'khy-quant', // 回退读到了别的包
    currentVersion: '0.1.187',
    newVersion: '1.8.0',
    env: {},
  });
  assert.strictEqual(r.trusted, false);
  assert.strictEqual(r.reason, 'cross_package');
  assert.match(r.message, /khy-quant/);
});

test('主版本反常跳变:0.1.187 → 1.8.0(同包也拦)→ 拒绝', () => {
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    upgradedPkg: 'khy-os',
    versionPkg: 'khy-os',
    currentVersion: '0.1.187',
    newVersion: '1.8.0',
    env: {},
  });
  assert.strictEqual(r.trusted, false);
  assert.strictEqual(r.reason, 'major_jump');
});

test('真实现场复现:目标 khy-os、~残骸使读回落到 khy-quant 1.8.0 → 拒绝', () => {
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    upgradedPkg: 'khy-os',
    versionPkg: 'khy-quant',
    currentVersion: '0.1.187',
    newVersion: '1.8.0',
    env: {},
  });
  assert.strictEqual(r.trusted, false);
  // 跨包优先于主版本跳变(两者都命中时先报跨包,更精确)。
  assert.strictEqual(r.reason, 'cross_package');
});

test('门关 → 逐字节回退:一律信任读回版本(即使 1.8.0 串包)', () => {
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    upgradedPkg: 'khy-os',
    versionPkg: 'khy-quant',
    currentVersion: '0.1.187',
    newVersion: '1.8.0',
    env: { KHY_PIP_VERSION_SANITY: 'off' },
  });
  assert.strictEqual(r.trusted, true);
});

test('坏输入不误伤:缺 targetPkg / 版本不可解析 → 信任(保守)', () => {
  assert.strictEqual(evaluateUpdatedVersion({ env: {} }).trusted, true);
  assert.strictEqual(
    evaluateUpdatedVersion({
      targetPkg: 'khy-os',
      versionPkg: 'khy-os',
      currentVersion: 'nightly',
      newVersion: 'unknown',
      env: {},
    }).trusted,
    true
  );
});

test('绝不抛:恶意 env 取值 throw → 信任(不阻断升级流)', () => {
  const hostile = {
    get KHY_PIP_VERSION_SANITY() { throw new Error('boom'); },
  };
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    versionPkg: 'khy-quant',
    currentVersion: '0.1.187',
    newVersion: '1.8.0',
    env: hostile,
  });
  assert.strictEqual(r.trusted, true);
});

test('同主版本内的正常前进(1.7.0 → 1.8.0)不误报', () => {
  const r = evaluateUpdatedVersion({
    targetPkg: 'khy-os',
    upgradedPkg: 'khy-os',
    versionPkg: 'khy-os',
    currentVersion: '1.7.0',
    newVersion: '1.8.0',
    env: {},
  });
  assert.strictEqual(r.trusted, true);
});
