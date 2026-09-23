'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  assessHydrationHealth,
  _RULES,
  _normalizeFacts,
  _fixIsSafe,
  CRITICAL_PACKAGES,
  _PACKAGE_HINTS,
  LEVEL_BLOCKER,
  LEVEL_WARNING,
} = require('../lib/hydrationHealth');

// ── 纯判断：空/未知输入 ───────────────────────────────────────────────────────
test('空 facts → 健康（未知一律不误报为拦路）', () => {
  const r = assessHydrationHealth({});
  assert.strictEqual(r.healthy, true);
  assert.strictEqual(r.blockers.length, 0);
  assert.strictEqual(r.checked, _RULES.length);
});

test('非对象输入不抛，退化为健康空判', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    const r = assessHydrationHealth(bad);
    assert.strictEqual(r.healthy, true);
    assert.strictEqual(r.blockers.length, 0);
  }
});

// ── 各拦路规则命中 ────────────────────────────────────────────────────────────
test('node_modules 缺失 → no-node-modules 拦路', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: false });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(ids.includes('no-node-modules'));
  assert.strictEqual(r.healthy, false);
});

test('marker 在但 node_modules 不在 → 裂脑双命中', () => {
  const r = assessHydrationHealth({ bootstrapMarker: true, nodeModulesPresent: false });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(ids.includes('splitbrain-marker'));
  assert.ok(ids.includes('no-node-modules'));
});

test('marker 在且 node_modules 在 → 不触发裂脑', () => {
  const r = assessHydrationHealth({ bootstrapMarker: true, nodeModulesPresent: true });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(!ids.includes('splitbrain-marker'));
});

test('关键包缺失 → missing-critical-package 拦路', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true, missingPackages: ['express'] });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(ids.includes('missing-critical-package'));
});

test('missingPackages 空数组 → 不触发（node_modules 齐全）', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true, missingPackages: [] });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(!ids.includes('missing-critical-package'));
});

test('@khy/shared 软链断裂 → shared-link-broken 拦路', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true, sharedLinkOk: false });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(ids.includes('shared-link-broken'));
});

// ── 空心包（hollow）：第三态，2026-09-21 补 ───────────────────────────────────
// 复现的故障：services/backend/node_modules/ink 是指向 .pnpm 空实体的符号链接，
// existsSync 跟随链接报「存在」⇒ 存在性判据全说好 ⇒ bootstrap 跳过 npm install
// ⇒ 永不自愈。CJS require 靠向上回退侥幸能跑，ESM import() 不回退直接崩。
test('空心包 → hollow-package 拦路', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true, hollowPackages: ['ink'] });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(ids.includes('hollow-package'));
  assert.strictEqual(r.healthy, false);
});

test('hollowPackages 空数组 → 不触发（无空壳）', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true, hollowPackages: [] });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(!ids.includes('hollow-package'));
});

test('hollowPackages 未知（null）→ 不误报', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(!ids.includes('hollow-package'));
});

test('_normalizeFacts 过滤非关键包 / 去重 hollowPackages', () => {
  const f = _normalizeFacts({ hollowPackages: ['ink', 'junk', 'ink', 42] });
  assert.deepStrictEqual(f.hollowPackages, ['ink']);
});

test('_normalizeFacts 非数组 hollowPackages → null', () => {
  assert.strictEqual(_normalizeFacts({ hollowPackages: 'ink' }).hollowPackages, null);
});

// 口径冲突：同一个包不可能既「不在」又「空壳」。missing 为强，从 hollow 里剔除，
// 免得两条互相矛盾的拦路项把用户绕晕。
test('同一包同时报 missing 与 hollow → missing 优先，hollow 剔除该包', () => {
  const f = _normalizeFacts({ missingPackages: ['ws'], hollowPackages: ['ws', 'ink'] });
  assert.deepStrictEqual(f.missingPackages, ['ws']);
  assert.deepStrictEqual(f.hollowPackages, ['ink']);
});

test('空心包与真缺失是两条独立拦路项（修法不同，不能合并）', () => {
  const r = assessHydrationHealth({
    nodeModulesPresent: true,
    missingPackages: ['ws'],
    hollowPackages: ['ink'],
  });
  const ids = r.blockers.map((b) => b.id);
  assert.ok(ids.includes('missing-critical-package'), '真缺失须报');
  assert.ok(ids.includes('hollow-package'), '空壳须报');
});

test('ink 必须在 CRITICAL_PACKAGES 内（ESM-only，空壳即崩 TUI）', () => {
  assert.ok(CRITICAL_PACKAGES.includes('ink'));
});

// ── 提醒规则 ──────────────────────────────────────────────────────────────────
test('便携 Node 缺失 → portable-node-missing 提醒（非拦路）', () => {
  const r = assessHydrationHealth({ portableNodeOk: false });
  const wids = r.warnings.map((w) => w.id);
  assert.ok(wids.includes('portable-node-missing'));
  assert.strictEqual(r.blockers.length, 0);
  assert.strictEqual(r.healthy, true);
});

test('依赖在但 seed 未完成 → seed-missing 提醒', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: true, seedMarker: false });
  const wids = r.warnings.map((w) => w.id);
  assert.ok(wids.includes('seed-missing'));
});

test('seed-missing 不在 node_modules 缺失时误报', () => {
  const r = assessHydrationHealth({ nodeModulesPresent: false, seedMarker: false });
  const wids = r.warnings.map((w) => w.id);
  assert.ok(!wids.includes('seed-missing'));
});

test('可选依赖降级 → optional-degraded 提醒', () => {
  const r = assessHydrationHealth({ optionalDegraded: true });
  const wids = r.warnings.map((w) => w.id);
  assert.ok(wids.includes('optional-degraded'));
  assert.strictEqual(r.blockers.length, 0);
});

// ── _normalizeFacts 保守规整 ──────────────────────────────────────────────────
test('_normalizeFacts 把非布尔收敛为 null，missingPackages 过滤非关键包', () => {
  const f = _normalizeFacts({
    nodeModulesPresent: 'yes',
    missingPackages: ['express', 'junk-pkg', 'express', 42],
  });
  assert.strictEqual(f.nodeModulesPresent, null);
  assert.deepStrictEqual(f.missingPackages, ['express']); // 去重 + 只留关键包
});

test('_normalizeFacts 非数组 missingPackages → null', () => {
  assert.strictEqual(_normalizeFacts({ missingPackages: 'express' }).missingPackages, null);
});

// ── 规则表健康度 ──────────────────────────────────────────────────────────────
test('每条规则字段完整、level 合法、修法安全', () => {
  for (const r of _RULES) {
    assert.ok(typeof r.id === 'string' && r.id, 'id');
    assert.ok(r.level === LEVEL_BLOCKER || r.level === LEVEL_WARNING, `${r.id} level`);
    assert.ok(typeof r.title === 'string' && r.title, `${r.id} title`);
    assert.ok(typeof r.fix === 'string' && r.fix, `${r.id} fix`);
    assert.ok(typeof r.when === 'function', `${r.id} when`);
    assert.ok(_fixIsSafe(r.fix), `${r.id} 修法含危险动作`);
  }
});

test('规则 id 无重复', () => {
  const ids = _RULES.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('每个 CRITICAL_PACKAGES 都有 _PACKAGE_HINTS 文案', () => {
  for (const p of CRITICAL_PACKAGES) {
    assert.ok(typeof _PACKAGE_HINTS[p] === 'string' && _PACKAGE_HINTS[p].length > 0, `${p} 缺 hint`);
  }
});

test('CRITICAL_PACKAGES 非空、无重复', () => {
  assert.ok(CRITICAL_PACKAGES.length > 0);
  assert.strictEqual(new Set(CRITICAL_PACKAGES).size, CRITICAL_PACKAGES.length);
});

// ── 反漂移护栏：CRITICAL_PACKAGES 每项必须是 backend 真实运行时依赖 ───────────
// 若 package.json 改了依赖名/删了依赖，这里会红，逼维护者同步 CRITICAL_PACKAGES，
// 避免自检去 stat 一个根本不该存在的包（永远误报缺失）。
test('反漂移：每个 CRITICAL_PACKAGES 都由 backend 或 @khy/shared 声明', () => {
  const manifests = [
    path.resolve(__dirname, '..', '..', 'services', 'backend', 'package.json'),
    path.resolve(__dirname, '..', '..', 'platform', 'packages', 'shared', 'package.json'),
  ].map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const deps = Object.assign({}, ...manifests.map(pkg => ({
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
  })));
  for (const p of CRITICAL_PACKAGES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(deps, p),
      `漂移：CRITICAL_PACKAGES 的 "${p}" 不在 backend 或 @khy/shared 的运行时依赖中。` +
        `依赖若已改名/移除，请同步更新 services/backend/src/services/restore/hydrationHealth.js。`
    );
  }
});

// ── 修法安全整体断言 ──────────────────────────────────────────────────────────
test('全部修法文本不含 commit/push/rm 危险文件/curl/publish', () => {
  const joined = _RULES.map((r) => r.fix).join(' ').toLowerCase();
  for (const t of ['git commit', 'git push', 'rm -rf /', 'curl ', 'wget ', 'npm publish', 'twine']) {
    assert.ok(!joined.includes(t), `修法含危险动作 ${t}`);
  }
});

// ── doc 一致性：OPS-MAN-070 落盘 == 生成器输出（防手改漂移）───────────────────
test('doc 一致性：OPS-MAN-070 落盘 == 生成器输出', (t) => {
  const { requireExtensionModule } = require('../lib/ext-run');
  const cli = requireExtensionModule('khy-diagnostics', { command: 'doctor-hydration' });
  if (!cli) return t.skip('拓展 khy-diagnostics 未安装 —— 这份文档由它生成，没有生成器就没有可比对的基准（删目录即卸载）');
  const { buildDoc, DOC_PATH } = cli;
  const onDisk = fs.readFileSync(DOC_PATH, 'utf8');
  assert.strictEqual(
    onDisk,
    buildDoc(),
    '落盘的 OPS-MAN-070 与生成器不一致，请跑 node scripts/hydration-doctor.js --gen-doc 重生成'
  );
  const g = buildDoc();
  assert.ok(g.includes('@khy-os/khy-os'));
  assert.ok(g.includes('splitbrain'));
  assert.ok(g.includes('commit/push')); // 红线声明在
  // 关键包表行数 === CRITICAL_PACKAGES 数
  const pkgRows = g.split('\n').filter((l) => /^\| `[^`]+` \| .+塌陷|^\| `@?[a-z0-9/-]+` \|/.test(l));
  // 规则表行数 === _RULES 数
  const ruleRows = g.split('\n').filter((l) => /^\| `[a-z-]+` \| (拦路|提醒) \|/.test(l));
  assert.strictEqual(ruleRows.length, _RULES.length);
  assert.ok(pkgRows.length >= CRITICAL_PACKAGES.length);
});
