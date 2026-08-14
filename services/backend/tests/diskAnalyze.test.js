'use strict';

/**
 * diskAnalyze 引擎测试 —— 有界只读扫描 + 分类 + 内容 hash 去重(注入 mock fs/crypto,无需真盘)。
 *
 * 不变量:
 *   1. 大文件按 minSize 阈值命中并按体积降序。
 *   2. 旧安装包:命中安装包模式 且 早于 olderThanDays。
 *   3. 重复文件:同大小 且 内容 sha1 相同才成组(仅同大小不同内容不算重复)。
 *   4. 预算/条目上限耗尽 → truncated:true(结构性根治「静默全盘递归被杀」)。
 *   5. 恒只读:工具 isReadOnly()===true;门关 → 工具导出为哑对象。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const engine = require('../src/services/diskAnalyze');

// ── 内存 mock 磁盘:posix 风格,支持 readdirSync(withFileTypes)/lstatSync/readFileSync ──
function makeDisk(tree) {
  // tree: { '/abs/path': { dir:true } | { size, mtimeMs, content } }
  const nodes = new Map(Object.entries(tree));
  function get(p) { return nodes.get(p); }
  function childrenOf(dir) {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    const names = new Set();
    for (const key of nodes.keys()) {
      if (key === dir) continue;
      if (key.startsWith(prefix)) {
        const first = key.slice(prefix.length).split('/')[0];
        if (first) names.add(first);
      }
    }
    return [...names];
  }
  return {
    readdirSync(p, opts) {
      const n = get(p);
      if (!n || !n.dir) { const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e; }
      const names = childrenOf(p);
      if (opts && opts.withFileTypes) {
        return names.map((name) => {
          const child = get(p.replace(/\/$/, '') + '/' + name);
          const isDir = !!(child && child.dir);
          return {
            name,
            isDirectory: () => isDir,
            isFile: () => !isDir,
            isSymbolicLink: () => false,
          };
        });
      }
      return names;
    },
    lstatSync(p) {
      const n = get(p);
      if (!n) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return {
        isDirectory: () => !!n.dir,
        isFile: () => !n.dir,
        isSymbolicLink: () => false,
        size: n.size || 0,
        mtimeMs: n.mtimeMs || 0,
      };
    },
    readFileSync(p) {
      const n = get(p);
      if (!n || n.dir) { const e = new Error('EISDIR'); e.code = 'EISDIR'; throw e; }
      return Buffer.from(String(n.content || ''));
    },
  };
}

const NOW = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;
const MB = 1024 * 1024;

function deps(fsImpl) {
  return { fsImpl, cryptoImpl: crypto, now: () => NOW, platform: 'linux' };
}

test('大文件:按 minSize 命中并降序', () => {
  const disk = makeDisk({
    '/root': { dir: true },
    '/root/big.bin': { size: 200 * MB, mtimeMs: NOW },
    '/root/huge.bin': { size: 500 * MB, mtimeMs: NOW },
    '/root/small.txt': { size: 1024, mtimeMs: NOW },
  });
  const r = engine.analyze({ roots: ['/root'], find: ['large'], deps: deps(disk),
    env: { KHY_DISKANALYZE_MIN_SIZE_MB: '100' } });
  assert.strictEqual(r.largeFiles.length, 2);
  assert.ok(r.largeFiles[0].path.endsWith('huge.bin'));   // 降序
  assert.ok(r.largeFiles[1].path.endsWith('big.bin'));
});

test('旧安装包:安装包模式 + 早于阈值', () => {
  const disk = makeDisk({
    '/root': { dir: true },
    '/root/old-setup.exe': { size: 50 * MB, mtimeMs: NOW - 300 * DAY },
    '/root/fresh.msi': { size: 50 * MB, mtimeMs: NOW - 5 * DAY },
    '/root/data.txt': { size: 50 * MB, mtimeMs: NOW - 300 * DAY },
  });
  const r = engine.analyze({ roots: ['/root'], find: ['installers'], deps: deps(disk),
    env: { KHY_DISKANALYZE_OLD_INSTALLER_DAYS: '180' } });
  assert.strictEqual(r.oldInstallers.length, 1);
  assert.ok(r.oldInstallers[0].path.endsWith('old-setup.exe'));
  assert.ok(Math.round(r.oldInstallers[0].ageDays) === 300);
});

test('重复文件:同大小+同内容才成组(同大小异内容不算)', () => {
  const dupContent = 'X'.repeat(4096);
  const disk = makeDisk({
    '/root': { dir: true },
    '/root/a.dat': { size: 4096, mtimeMs: NOW, content: dupContent },
    '/root/b.dat': { size: 4096, mtimeMs: NOW, content: dupContent },   // 与 a 内容相同
    '/root/c.dat': { size: 4096, mtimeMs: NOW, content: 'Y'.repeat(4096) }, // 同大小异内容
  });
  const r = engine.analyze({ roots: ['/root'], find: ['duplicates'], deps: deps(disk) });
  assert.strictEqual(r.duplicateGroups.length, 1);
  assert.strictEqual(r.duplicateGroups[0].files.length, 2);
  assert.strictEqual(r.duplicateGroups[0].wastedBytes, 4096);
});

test('预算耗尽 → truncated:true(注入已超时的 deadline)', () => {
  const disk = makeDisk({
    '/root': { dir: true },
    '/root/a': { size: 1, mtimeMs: NOW },
    '/root/b': { size: 1, mtimeMs: NOW },
  });
  const walked = engine.walker.walk(['/root'], deps(disk), { deadline: { exceeded: () => true } });
  assert.strictEqual(walked.truncated, true);
  assert.strictEqual(walked.reason, 'time-budget');
});

test('walker:maxEntries 上限触发 truncated(≥floor 1000 条)', () => {
  const tree = { '/root': { dir: true } };
  for (let i = 0; i < 1500; i += 1) tree['/root/f' + i] = { size: 1, mtimeMs: NOW };
  const disk = makeDisk(tree);
  const walked = engine.walker.walk(['/root'], deps(disk), { env: { KHY_DISKANALYZE_MAX_ENTRIES: '1000' } });
  assert.strictEqual(walked.truncated, true);
  assert.strictEqual(walked.reason, 'max-entries');
});

test('walker:不跟随符号链接目录 / 跳过噪声目录', () => {
  const disk = makeDisk({
    '/root': { dir: true },
    '/root/node_modules': { dir: true },
    '/root/node_modules/huge.bin': { size: 999 * MB, mtimeMs: NOW },
    '/root/keep.bin': { size: 200 * MB, mtimeMs: NOW },
  });
  const r = engine.analyze({ roots: ['/root'], find: ['large'], deps: deps(disk),
    env: { KHY_DISKANALYZE_MIN_SIZE_MB: '100' } });
  assert.strictEqual(r.largeFiles.length, 1);
  assert.ok(r.largeFiles[0].path.endsWith('keep.bin'));   // node_modules 被跳过
});

test('工具:isReadOnly()===true 且 非破坏性', () => {
  const tool = require('../src/tools/DiskAnalyzeTool');
  assert.strictEqual(tool.isReadOnly(), true);
  assert.strictEqual(tool.isDestructive(), false);
});

test('工具:门关 → 导出哑对象(自动发现跳过)', () => {
  const p = require.resolve('../src/tools/DiskAnalyzeTool');
  const saved = process.env.KHY_DISKANALYZE_TOOL;
  process.env.KHY_DISKANALYZE_TOOL = '0';
  delete require.cache[p];
  const off = require('../src/tools/DiskAnalyzeTool');
  assert.strictEqual(off._khyDiskAnalyzeDisabled, true);
  assert.ok(!off.name);
  // 还原
  if (saved === undefined) delete process.env.KHY_DISKANALYZE_TOOL;
  else process.env.KHY_DISKANALYZE_TOOL = saved;
  delete require.cache[p];
});

test('analyze:全找默认 + report 非空', () => {
  const disk = makeDisk({
    '/root': { dir: true },
    '/root/big.iso': { size: 300 * MB, mtimeMs: NOW },
  });
  const r = engine.analyze({ roots: ['/root'], deps: deps(disk),
    env: { KHY_DISKANALYZE_MIN_SIZE_MB: '100' } });
  assert.strictEqual(r.success, true);
  assert.ok(Array.isArray(r.largeFiles) && Array.isArray(r.oldInstallers) && Array.isArray(r.duplicateGroups));
  assert.ok(typeof r.report === 'string' && r.report.length > 0);
});

test('analyze:绝不抛(坏 deps → fail-soft success:false)', () => {
  assert.doesNotThrow(() => engine.analyze({ roots: ['/x'], deps: { fsImpl: null } }));
});
