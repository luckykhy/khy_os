'use strict';

// 「平台自适应」回归:nodePlatformLabel 把 Node 原始 process.platform id 映射为
// 诚实的人类可读标签——已知平台正确命名,未知平台如实报告(绝不谎称 Linux),
// 门 KHY_PLATFORM_LABEL_ADAPTIVE 默认开·关则逐字节回退历史三元(未知→Linux)。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  nodePlatformLabel,
  legacyPlatformLabel,
  resolvePlatformLabel,
} = require('../../src/constants/nodePlatformLabel');

test('adaptive: known Node platforms map to proper display names', () => {
  assert.equal(nodePlatformLabel('darwin'), 'macOS');
  assert.equal(nodePlatformLabel('win32'), 'Windows');
  assert.equal(nodePlatformLabel('linux'), 'Linux');
  assert.equal(nodePlatformLabel('freebsd'), 'FreeBSD');
  assert.equal(nodePlatformLabel('openbsd'), 'OpenBSD');
  assert.equal(nodePlatformLabel('sunos'), 'SunOS');
  assert.equal(nodePlatformLabel('aix'), 'AIX');
  assert.equal(nodePlatformLabel('android'), 'Android');
});

test('adaptive: unknown platform is reported honestly, never "Linux"', () => {
  assert.equal(nodePlatformLabel('fuchsia'), 'Fuchsia');
  assert.notEqual(nodePlatformLabel('freebsd'), 'Linux');
  assert.notEqual(nodePlatformLabel('sunos'), 'Linux');
});

test('adaptive: empty / null / whitespace → "Unknown"', () => {
  assert.equal(nodePlatformLabel(''), 'Unknown');
  assert.equal(nodePlatformLabel(null), 'Unknown');
  assert.equal(nodePlatformLabel(undefined), 'Unknown');
  assert.equal(nodePlatformLabel('   '), 'Unknown');
});

test('adaptive: case-insensitive on the raw id', () => {
  assert.equal(nodePlatformLabel('DARWIN'), 'macOS');
  assert.equal(nodePlatformLabel('Win32'), 'Windows');
});

test('legacy: preserves the historical ternary (unknown → Linux)', () => {
  assert.equal(legacyPlatformLabel('darwin'), 'macOS');
  assert.equal(legacyPlatformLabel('win32'), 'Windows');
  assert.equal(legacyPlatformLabel('linux'), 'Linux');
  assert.equal(legacyPlatformLabel('freebsd'), 'Linux'); // the old lie, kept for byte-revert
  assert.equal(legacyPlatformLabel('sunos'), 'Linux');
  assert.equal(legacyPlatformLabel(''), 'Linux');
});

test('resolve: default-on uses adaptive labels', () => {
  assert.equal(resolvePlatformLabel('freebsd', {}), 'FreeBSD');
  assert.equal(resolvePlatformLabel('freebsd', { KHY_PLATFORM_LABEL_ADAPTIVE: '' }), 'FreeBSD');
  assert.equal(resolvePlatformLabel('freebsd', { KHY_PLATFORM_LABEL_ADAPTIVE: '1' }), 'FreeBSD');
});

test('resolve: gate off → byte-reverts to legacy (unknown → Linux)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.equal(
      resolvePlatformLabel('freebsd', { KHY_PLATFORM_LABEL_ADAPTIVE: off }),
      'Linux',
      `gate value ${off} must byte-revert`
    );
  }
  // Known platforms are byte-identical whether the gate is on or off.
  assert.equal(resolvePlatformLabel('darwin', { KHY_PLATFORM_LABEL_ADAPTIVE: 'off' }), 'macOS');
  assert.equal(resolvePlatformLabel('win32', { KHY_PLATFORM_LABEL_ADAPTIVE: 'off' }), 'Windows');
  assert.equal(resolvePlatformLabel('linux', { KHY_PLATFORM_LABEL_ADAPTIVE: 'off' }), 'Linux');
});
