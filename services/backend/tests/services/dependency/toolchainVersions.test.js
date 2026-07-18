'use strict';

/**
 * toolchainVersions.test.js — 「按客户需求选版本」工具链版本矩阵纯叶子。
 *
 * 验收:门控默认开/显式关字节回退;别名归一;parseDepSpec 拆 @version;
 * 版本白名单(非法版本一律 null,绝不拼接外来字符串);平台键缺省 → null;
 * 防御性拷贝(改写返回值不污染表);JDK/Python/.NET 矩阵命中;.NET darwin → null。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const tv = require('../../../src/services/dependency/toolchainVersions');

test('isEnabled: 默认开,仅 {0,false,off,no} 关', () => {
  assert.equal(tv.isEnabled({}), true);
  assert.equal(tv.isEnabled({ KHY_DEP_VERSIONS: '' }), true);
  assert.equal(tv.isEnabled({ KHY_DEP_VERSIONS: '1' }), true);
  assert.equal(tv.isEnabled({ KHY_DEP_VERSIONS: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.equal(tv.isEnabled({ KHY_DEP_VERSIONS: off }), false, `应关:${off}`);
  }
});

test('resolveDepId: 别名 / 大小写归一到 canonical', () => {
  assert.equal(tv.resolveDepId('jdk'), 'openjdk');
  assert.equal(tv.resolveDepId('JAVA'), 'openjdk');
  assert.equal(tv.resolveDepId('javac'), 'openjdk');
  assert.equal(tv.resolveDepId('openjdk'), 'openjdk');
  assert.equal(tv.resolveDepId('py'), 'python3');
  assert.equal(tv.resolveDepId('python'), 'python3');
  assert.equal(tv.resolveDepId('.net'), 'dotnet');
  assert.equal(tv.resolveDepId('net'), 'dotnet');
  // 未知原样小写返回(供调用方继续查 registry)
  assert.equal(tv.resolveDepId('ffmpeg'), 'ffmpeg');
  assert.equal(tv.resolveDepId(''), '');
  assert.equal(tv.resolveDepId(null), '');
});

test('parseDepSpec: 拆 depId@version,别名归一', () => {
  assert.deepEqual(tv.parseDepSpec('jdk@17'), { depId: 'openjdk', version: '17' });
  assert.deepEqual(tv.parseDepSpec('openjdk@8'), { depId: 'openjdk', version: '8' });
  assert.deepEqual(tv.parseDepSpec('python3'), { depId: 'python3', version: null });
  assert.deepEqual(tv.parseDepSpec('py@3.11'), { depId: 'python3', version: '3.11' });
  assert.deepEqual(tv.parseDepSpec('dotnet@'), { depId: 'dotnet', version: null });
  assert.deepEqual(tv.parseDepSpec(''), { depId: '', version: null });
  assert.deepEqual(tv.parseDepSpec('  jdk@17  '), { depId: 'openjdk', version: '17' });
});

test('isVersionable / supportedVersions / defaultVersion', () => {
  assert.equal(tv.isVersionable('jdk'), true);
  assert.equal(tv.isVersionable('openjdk'), true);
  assert.equal(tv.isVersionable('python'), true);
  assert.equal(tv.isVersionable('dotnet'), true);
  assert.equal(tv.isVersionable('ffmpeg'), false);
  assert.deepEqual(tv.supportedVersions('jdk'), ['8', '11', '17', '21']);
  assert.deepEqual(tv.supportedVersions('python3'), ['3.10', '3.11', '3.12', '3.13']);
  assert.deepEqual(tv.supportedVersions('ffmpeg'), []);
  assert.equal(tv.defaultVersion('openjdk'), '21');
  assert.equal(tv.defaultVersion('python3'), '3.12');
  assert.equal(tv.defaultVersion('dotnet'), '8');
  assert.equal(tv.defaultVersion('ffmpeg'), null);
});

test('listVersionable: 返回新数组快照(改写不污染表)', () => {
  const list = tv.listVersionable();
  const ids = list.map((x) => x.depId).sort();
  assert.deepEqual(ids, ['dotnet', 'openjdk', 'python3']);
  // 改写返回值不影响后续调用
  list[0].versions.push('999');
  assert.equal(tv.supportedVersions(list[0].depId).includes('999'), false);
});

test('resolveVersionedCommand: JDK 三平台命中 curated argv', () => {
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'openjdk', version: '17', platform: 'linux', env: {} }),
    ['apt-get', 'install', '-y', 'openjdk-17-jdk'],
  );
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'jdk', version: '8', platform: 'darwin', env: {} }),
    ['brew', 'install', 'openjdk@8'],
  );
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'java', version: '21', platform: 'win32', env: {} }),
    ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.21.JDK', '-e'],
  );
});

test('resolveVersionedCommand: Python 命中', () => {
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'python', version: '3.11', platform: 'linux', env: {} }),
    ['apt-get', 'install', '-y', 'python3.11'],
  );
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'py', version: '3.12', platform: 'darwin', env: {} }),
    ['brew', 'install', 'python@3.12'],
  );
});

test('resolveVersionedCommand: 版本白名单——非法 / 任意版本一律 null', () => {
  assert.equal(tv.resolveVersionedCommand({ depId: 'openjdk', version: '99', platform: 'linux', env: {} }), null);
  assert.equal(tv.resolveVersionedCommand({ depId: 'openjdk', version: '', platform: 'linux', env: {} }), null);
  assert.equal(tv.resolveVersionedCommand({ depId: 'openjdk', version: null, platform: 'linux', env: {} }), null);
  // 注入式字符串绝不入命令
  assert.equal(tv.resolveVersionedCommand({ depId: 'openjdk', version: '17; rm -rf /', platform: 'linux', env: {} }), null);
  assert.equal(tv.resolveVersionedCommand({ depId: 'openjdk', version: '__proto__', platform: 'linux', env: {} }), null);
});

test('resolveVersionedCommand: 非版本可选 depId → null', () => {
  assert.equal(tv.resolveVersionedCommand({ depId: 'ffmpeg', version: '4', platform: 'linux', env: {} }), null);
});

test('resolveVersionedCommand: 门控关 → null(字节回退默认)', () => {
  assert.equal(
    tv.resolveVersionedCommand({ depId: 'openjdk', version: '17', platform: 'linux', env: { KHY_DEP_VERSIONS: 'off' } }),
    null,
  );
});

test('resolveVersionedCommand: .NET darwin 无干净 cask → null', () => {
  // linux / win32 命中,darwin 键缺省 → null(诚实降级到 registry 默认)
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'dotnet', version: '6', platform: 'linux', env: {} }),
    ['apt-get', 'install', '-y', 'dotnet-sdk-6.0'],
  );
  assert.deepEqual(
    tv.resolveVersionedCommand({ depId: 'dotnet', version: '8', platform: 'win32', env: {} }),
    ['winget', 'install', '--id', 'Microsoft.DotNet.SDK.8', '-e'],
  );
  assert.equal(tv.resolveVersionedCommand({ depId: 'dotnet', version: '8', platform: 'darwin', env: {} }), null);
});

test('resolveVersionedCommand: 防御性拷贝——改写返回值不污染矩阵', () => {
  const a = tv.resolveVersionedCommand({ depId: 'openjdk', version: '17', platform: 'linux', env: {} });
  a.push('--malicious');
  const b = tv.resolveVersionedCommand({ depId: 'openjdk', version: '17', platform: 'linux', env: {} });
  assert.deepEqual(b, ['apt-get', 'install', '-y', 'openjdk-17-jdk']);
});

test('describeVersions: 正本快照含门控名 + 三工具链', () => {
  const d = tv.describeVersions();
  assert.equal(d.gate, 'KHY_DEP_VERSIONS');
  assert.equal(typeof d.note, 'string');
  assert.equal(d.toolchains.length, 3);
});
