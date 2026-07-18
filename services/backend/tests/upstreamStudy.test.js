'use strict';

/**
 * upstreamStudy 服务 facade 测试 —— 编排:inspect 只读列举 → 分类 → 基线 diff → Top-N → report。
 * 全部依赖注入(inspect / fsImpl / now),确定性、绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');
const nodePath = require('path');

const study = require('../src/services/upstreamStudy');

// ── 内存 mock fs(供基线遍历):posix,支持 readdirSync(withFileTypes)/lstatSync ──
function makeDisk(tree) {
  const nodes = new Map(Object.entries(tree));
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
      const n = nodes.get(p);
      if (!n || !n.dir) { const e = new Error('ENOTDIR'); e.code = 'ENOTDIR'; throw e; }
      const names = childrenOf(p);
      if (opts && opts.withFileTypes) {
        return names.map((name) => {
          const child = nodes.get(p.replace(/\/$/, '') + '/' + name);
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
      const n = nodes.get(p);
      if (!n) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => !!n.dir, isFile: () => !n.dir, isSymbolicLink: () => false, size: n.size || 0 };
    },
  };
}

const ENTRIES = [
  { name: 'proj/CHANGELOG.md', size: 1200, isDirectory: false },
  { name: 'proj/src/app.rs', size: 8000, isDirectory: false },
  { name: 'proj/src/ui.rs', size: 30000, isDirectory: false },
  { name: 'proj/tests/app_test.rs', size: 2000, isDirectory: false },
  { name: 'proj/Cargo.lock', size: 90000, isDirectory: false },
  { name: 'proj/target/debug/app', size: 500000, isDirectory: false },
  { name: 'proj/assets/logo.png', size: 40000, isDirectory: false },
  { name: 'proj/.env', size: 100, isDirectory: false },
];

function fakeInspect(extra = {}) {
  return async () => Object.assign({ success: true, kindToken: 'zip', truncated: false, entries: ENTRIES }, extra);
}

test('study:分类计数正确, 精华清单按价值排序', async () => {
  const r = await study.study({ archive: '/tmp/proj.zip' }, { inspect: fakeInspect() });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.totals.files, 8);
  // CHANGELOG(changelog) + app.rs,ui.rs(source) + app_test.rs(test) = 4 essence
  assert.strictEqual(r.totals.essence, 4);
  assert.strictEqual(r.totals.dross, 4);          // Cargo.lock, target/, logo.png, .env
  assert.deepStrictEqual(Object.keys(r.dross.buckets).sort(), ['binary', 'lockfile', 'secret', 'vendored']);
  // 排序:changelog 最高在首
  assert.ok(r.essence[0].path.endsWith('CHANGELOG.md'));
  assert.ok(typeof r.report === 'string' && r.report.length > 0);
});

test('study:recognized 识别项目', async () => {
  const r = await study.study({ archive: '/tmp/DeepSeek-TUI-main.zip' },
    { inspect: async () => ({ success: true, kindToken: 'zip', entries: [{ name: 'DeepSeek-TUI-main/src/app.rs', size: 10, isDirectory: false }] }) });
  assert.ok(r.recognized);
  assert.strictEqual(r.recognized.id, 'deepseek-tui');
});

test('study:top 覆盖限制清单长度', async () => {
  const r = await study.study({ archive: '/tmp/proj.zip', top: 2 }, { inspect: fakeInspect() });
  assert.strictEqual(r.essence.length, 2);
  assert.strictEqual(r.essenceTotal, 4);          // 总数不被 top 影响
});

test('study:基线 diff(新增/改动/删除, 剥公共顶层目录后按相对路径比对)', async () => {
  const disk = makeDisk({
    '/base': { dir: true },
    '/base/src': { dir: true },
    '/base/src/app.rs': { size: 999, mtimeMs: 0 },   // 与包内 8000 不同 → 改动
    '/base/src/gone.rs': { size: 10, mtimeMs: 0 },    // 包内没有 → 删除
  });
  const r = await study.study({ archive: '/tmp/proj.zip', baseline: '/base' },
    { inspect: fakeInspect(), fsImpl: disk, now: () => 1 });
  assert.ok(r.diff);
  assert.strictEqual(r.diff.changedCount, 1);       // app.rs
  assert.ok(r.diff.newCount >= 1);                  // 其余全是新增
  assert.strictEqual(r.diff.removedCount, 1);
  assert.deepStrictEqual(r.diff.removed, ['src/gone.rs']);
  // 改动的 app.rs 在精华里应标 isChanged
  const app = r.essence.find((e) => e.path.endsWith('app.rs'));
  assert.strictEqual(app.isChanged, true);
});

test('study:inspect 失败 → success:false 诚实上报', async () => {
  const r = await study.study({ archive: '/tmp/x.zip' },
    { inspect: async () => ({ success: false, error: 'zip 列表失败: boom' }) });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('boom'));
});

test('study:未提供 archive → success:false', async () => {
  const r = await study.study({}, { inspect: fakeInspect() });
  assert.strictEqual(r.success, false);
});

test('study:门关 CATALOG ⇒ 全 neutral(逐字节回退, 无精华/糟粕划分)', async () => {
  const r = await study.study({ archive: '/tmp/proj.zip', env: { KHY_UPSTREAM_STUDY_CATALOG: '0' } },
    { inspect: fakeInspect() });
  assert.strictEqual(r.totals.essence, 0);
  assert.strictEqual(r.totals.dross, 0);
  assert.strictEqual(r.totals.neutral, 8);
});

test('study:plan 移植计划(能改按波次分组、精华项带 portability、报告含移植计划段)', async () => {
  const r = await study.study({ archive: '/tmp/proj.zip' }, { inspect: fakeInspect() });
  assert.ok(r.plan && Array.isArray(r.plan.waves), 'plan.waves 存在');
  // changelog → W0;app.rs/ui.rs(source) → W2;app_test.rs(test) → W3
  const byWave = Object.fromEntries(r.plan.waves.map((w) => [w.wave, w.items.map((i) => i.path)]));
  assert.ok((byWave[0] || []).some((p) => p.endsWith('CHANGELOG.md')));
  assert.ok((byWave[3] || []).some((p) => p.endsWith('app_test.rs')));
  // 精华项被标注 portability + wave
  const app = r.essence.find((e) => e.path.endsWith('app.rs'));
  assert.strictEqual(app.portability, 'safe');
  assert.strictEqual(app.wave, 2);
  // 报告渲染移植计划段
  assert.ok(r.report.includes('移植计划'));
});

test('study:门关 PLAN ⇒ 无 plan 字段, 精华项无 portability(逐字节回退)', async () => {
  const r = await study.study({ archive: '/tmp/proj.zip', env: { KHY_UPSTREAM_STUDY_PLAN: '0' } },
    { inspect: fakeInspect() });
  assert.strictEqual(r.plan, undefined);
  const app = r.essence.find((e) => e.path.endsWith('app.rs'));
  assert.strictEqual(app.portability, undefined);
  assert.strictEqual(app.wave, undefined);
  assert.ok(!r.report.includes('移植计划'));
});

test('study:inspect 抛出也不抛, 返回 success:false', async () => {
  const r = await study.study({ archive: '/tmp/x.zip' },
    { inspect: async () => { throw new Error('kaboom'); } });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes('kaboom'));
});

test('_commonTopDir / _relOf:剥公共顶层目录', () => {
  assert.strictEqual(study._commonTopDir(['proj/a', 'proj/b/c']), 'proj');
  assert.strictEqual(study._commonTopDir(['a', 'proj/b']), '');   // 有顶层文件 → 不剥
  assert.strictEqual(study._commonTopDir(['x/a', 'y/b']), '');    // 不同顶层 → 不剥
  assert.strictEqual(study._relOf('proj/src/a.rs', 'proj'), 'src/a.rs');
  assert.strictEqual(study._relOf('other/a.rs', 'proj'), 'other/a.rs');
});

// ── 工具壳 ────────────────────────────────────────────────────────────
test('工具:isReadOnly()===true 且非破坏性', () => {
  const tool = require('../src/tools/UpstreamStudyTool');
  assert.strictEqual(tool.isReadOnly(), true);
  assert.strictEqual(tool.isDestructive(), false);
});

test('工具:门关 → 导出哑对象(自动发现跳过)', () => {
  const p = require.resolve('../src/tools/UpstreamStudyTool');
  const saved = process.env.KHY_UPSTREAM_STUDY_TOOL;
  process.env.KHY_UPSTREAM_STUDY_TOOL = '0';
  delete require.cache[p];
  const off = require('../src/tools/UpstreamStudyTool');
  assert.strictEqual(off._khyUpstreamStudyDisabled, true);
  assert.ok(!off.name);
  if (saved === undefined) delete process.env.KHY_UPSTREAM_STUDY_TOOL;
  else process.env.KHY_UPSTREAM_STUDY_TOOL = saved;
  delete require.cache[p];
});

void nodePath;
