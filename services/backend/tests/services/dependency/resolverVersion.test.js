'use strict';

/**
 * resolverVersion.test.js — buildInstallPlan 的「按需选版本」加性接缝。
 *
 * 验收:不传 version 时计划与今天逐字节相同(加性零回归);传白名单内版本覆盖命令并
 * 标 version;传非法 / 平台无映射版本退回默认且标 versionUnavailable;门控关字节回退。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const resolver = require('../../../src/services/dependency/resolver');

/** 纯内存 env(linux),避免真实 which/require。 */
function envLinux() {
  return {
    searchExecutable: () => null,
    resolveNodeModule: () => false,
    checkPythonPackage: () => false,
    platform: 'linux',
    cwd: '/tmp',
  };
}

test('buildInstallPlan: 不传 version → 与 registry 默认逐字节相同 + version 字段 null', () => {
  const plan = resolver.buildInstallPlan('openjdk', envLinux());
  assert.ok(plan, '应有计划');
  assert.equal(plan.version, null);
  assert.equal(plan.requestedVersion, null);
  assert.equal(plan.versionUnavailable, false);
  // registry 默认 apt 命令(default-jdk)未被版本覆盖
  assert.equal(plan.command.includes('default-jdk'), true);
});

test('buildInstallPlan: 传白名单版本 → 覆盖命令并标 version', () => {
  const plan = resolver.buildInstallPlan('openjdk', envLinux(), { version: '17' });
  assert.equal(plan.version, '17');
  assert.equal(plan.requestedVersion, '17');
  assert.equal(plan.versionUnavailable, false);
  assert.deepEqual(plan.command, ['apt-get', 'install', '-y', 'openjdk-17-jdk']);
  assert.equal(plan.displayCommand, 'apt-get install -y openjdk-17-jdk');
});

test('buildInstallPlan: 别名 + 版本(经 registry id 解析)', () => {
  // CLI 会先 parseDepSpec('jdk@8') → depId 'openjdk';此处直接验 resolver 接 version。
  const plan = resolver.buildInstallPlan('openjdk', envLinux(), { version: '8' });
  assert.deepEqual(plan.command, ['apt-get', 'install', '-y', 'openjdk-8-jdk']);
  assert.equal(plan.version, '8');
});

test('buildInstallPlan: 非法版本 → 退回默认 + versionUnavailable=true', () => {
  const plan = resolver.buildInstallPlan('openjdk', envLinux(), { version: '99' });
  assert.equal(plan.version, null);
  assert.equal(plan.requestedVersion, '99');
  assert.equal(plan.versionUnavailable, true);
  // 退回 registry 默认(未被覆盖)
  assert.equal(plan.command.includes('default-jdk'), true);
});

test('buildInstallPlan: 平台无按版本映射(.NET on darwin)→ 退回默认 + versionUnavailable', () => {
  const env = { ...envLinux(), platform: 'darwin' };
  const plan = resolver.buildInstallPlan('dotnet', env, { version: '8' });
  // darwin 无干净 cask → toolchainVersions 返 null → 退回 registry 默认
  assert.equal(plan.version, null);
  assert.equal(plan.requestedVersion, '8');
  assert.equal(plan.versionUnavailable, true);
});

test('buildInstallPlan: 门控关 → 即便传版本也字节回退默认', () => {
  const prev = process.env.KHY_DEP_VERSIONS;
  process.env.KHY_DEP_VERSIONS = 'off';
  try {
    const plan = resolver.buildInstallPlan('openjdk', envLinux(), { version: '17' });
    assert.equal(plan.version, null);
    assert.equal(plan.versionUnavailable, true); // 请求了但无映射(门控关)
    assert.equal(plan.command.includes('default-jdk'), true);
  } finally {
    if (prev === undefined) delete process.env.KHY_DEP_VERSIONS;
    else process.env.KHY_DEP_VERSIONS = prev;
  }
});

test('buildInstallPlan: 防御性拷贝——改写 plan.command 不污染下次', () => {
  const a = resolver.buildInstallPlan('openjdk', envLinux(), { version: '21' });
  a.command.push('--x');
  const b = resolver.buildInstallPlan('openjdk', envLinux(), { version: '21' });
  assert.deepEqual(b.command, ['apt-get', 'install', '-y', 'openjdk-21-jdk']);
});
