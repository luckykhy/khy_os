'use strict';

/**
 * diskAnalyzeCatalog 测试 —— 纯叶子分类/阈值/去重分组决策。门控 KHY_DISKANALYZE_CATALOG。
 */

const test = require('node:test');
const assert = require('node:assert');

const cat = require('../src/services/diskAnalyzeCatalog');

const ON = { KHY_DISKANALYZE_CATALOG: '1' };
const OFF = { KHY_DISKANALYZE_CATALOG: '0' };

test('extOf:取小写扩展名;隐藏文件/无扩展名返空', () => {
  assert.strictEqual(cat.extOf('/a/b/Setup.EXE'), '.exe');
  assert.strictEqual(cat.extOf('C:\\x\\foo.MSI'), '.msi');
  assert.strictEqual(cat.extOf('/a/.bashrc'), '');
  assert.strictEqual(cat.extOf('/a/noext'), '');
});

test('isInstaller:扩展名命中(跨平台并集)', () => {
  for (const p of ['a.exe', 'b.msi', 'c.dmg', 'd.pkg', 'e.deb', 'f.rpm', 'g.AppImage', 'h.iso']) {
    assert.strictEqual(cat.isInstaller('/x/' + p, ON), true, p);
  }
});

test('isInstaller:文件名模式命中(setup/install/...)', () => {
  assert.strictEqual(cat.isInstaller('/x/vc_redist.x64.exe', ON), true);
  assert.strictEqual(cat.isInstaller('/x/my-installer.bin', ON), true);
  assert.strictEqual(cat.isInstaller('/x/notes.txt', ON), false);
});

test('门关 → isInstaller 恒 false(逐字节回退)', () => {
  assert.strictEqual(cat.isInstaller('/x/setup.exe', OFF), false);
});

test('isOldInstaller:安装包且早于阈值', () => {
  const now = 1_000_000_000_000;
  const day = 24 * 3600 * 1000;
  const old = { path: '/x/setup.exe', mtimeMs: now - 200 * day };
  const fresh = { path: '/x/setup.exe', mtimeMs: now - 10 * day };
  assert.strictEqual(cat.isOldInstaller(old, now, ON), true);      // 200 > 180 默认
  assert.strictEqual(cat.isOldInstaller(fresh, now, ON), false);
  assert.strictEqual(cat.isOldInstaller({ path: '/x/a.txt', mtimeMs: now - 999 * day }, now, ON), false); // 非安装包
});

test('resolveMinSizeBytes / OldInstallerDays:默认与 env 覆盖', () => {
  assert.strictEqual(cat.resolveMinSizeBytes({}), 100 * 1024 * 1024);
  assert.strictEqual(cat.resolveMinSizeBytes({ KHY_DISKANALYZE_MIN_SIZE_MB: '250' }), 250 * 1024 * 1024);
  assert.strictEqual(cat.resolveOldInstallerDays({}), 180);
  assert.strictEqual(cat.resolveOldInstallerDays({ KHY_DISKANALYZE_OLD_INSTALLER_DAYS: '30' }), 30);
});

test('groupBySize:只保留 size≥2 且 size>0,按 size 降序', () => {
  const files = [
    { path: 'a', size: 100 }, { path: 'b', size: 100 },   // 组 100
    { path: 'c', size: 500 }, { path: 'd', size: 500 },   // 组 500
    { path: 'e', size: 100 },                              // 并入 100
    { path: 'lonely', size: 7 },                           // 单个,剔除
    { path: 'zero', size: 0 }, { path: 'zero2', size: 0 }, // size 0,剔除
  ];
  const groups = cat.groupBySize(files, ON);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].sizeBytes, 500);            // 降序
  assert.strictEqual(groups[1].sizeBytes, 100);
  assert.strictEqual(groups[1].files.length, 3);
});

test('门关 → groupBySize 返 []', () => {
  const files = [{ path: 'a', size: 9 }, { path: 'b', size: 9 }];
  assert.deepStrictEqual(cat.groupBySize(files, OFF), []);
});

test('selectHashCandidates:超单文件上限跳过并计数', () => {
  const env = { KHY_DISKANALYZE_CATALOG: '1', KHY_DISKANALYZE_HASH_MAX_FILE_MB: '1' };
  const big = 2 * 1024 * 1024; // 2MB > 1MB 上限
  const groups = [{ sizeBytes: big, files: [{ path: 'a', size: big }, { path: 'b', size: big }] }];
  const r = cat.selectHashCandidates(groups, env);
  assert.strictEqual(r.toHash.length, 0);
  assert.strictEqual(r.skippedTooBig, 2);
});

test('selectHashCandidates:超候选总数上限跳过并计数', () => {
  const env = { KHY_DISKANALYZE_CATALOG: '1', KHY_DISKANALYZE_HASH_MAX_FILES: '2' };
  const groups = [{ sizeBytes: 10, files: [
    { path: 'a', size: 10 }, { path: 'b', size: 10 }, { path: 'c', size: 10 }, { path: 'd', size: 10 },
  ] }];
  const r = cat.selectHashCandidates(groups, env);
  assert.strictEqual(r.toHash.length, 2);
  assert.strictEqual(r.skippedOverCount, 2);
  assert.strictEqual(r.toHash[0].sizeBytes, 10);
});

test('门关 → selectHashCandidates 空结果', () => {
  const groups = [{ sizeBytes: 10, files: [{ path: 'a', size: 10 }, { path: 'b', size: 10 }] }];
  const r = cat.selectHashCandidates(groups, OFF);
  assert.deepStrictEqual(r, { toHash: [], skippedTooBig: 0, skippedOverCount: 0 });
});

test('绝不抛:坏输入 fail-soft', () => {
  assert.doesNotThrow(() => cat.isInstaller(null, ON));
  assert.doesNotThrow(() => cat.groupBySize(null, ON));
  assert.doesNotThrow(() => cat.selectHashCandidates(null, ON));
  assert.doesNotThrow(() => cat.isOldInstaller(null, NaN, ON));
});
