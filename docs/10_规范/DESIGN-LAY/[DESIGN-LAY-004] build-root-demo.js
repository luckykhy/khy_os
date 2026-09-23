#!/usr/bin/env node
/**
 * @pattern Strategy
 *
 * build-root-demo.js — 「构建产物单一根」规则（[DESIGN-LAY-004] / LAYOUT-005）的**反例矩阵驱动**。
 *
 *   node _产物/build-root-demo.js --all                    # 12 场景矩阵
 *   node _产物/build-root-demo.js --scenario=scatter-new   # 单场景
 *   node _产物/build-root-demo.js --files="A:entries/x,B:apps/y/dist"
 *   node _产物/build-root-demo.js --scan                   # 真实仓库（只读）
 *   node _产物/build-root-demo.js --audit-clean            # clean.js 登记表体检
 *
 * ## 它为什么存在
 *
 * 规则文档里的每条断言都要有实测输出。判定逻辑本身是**生产代码**
 * （`scripts/lib/buildRootGuard.js`，与 `scripts/ci/check-build-root.js` 共用），
 * 本文件只提供**夹具**（fixture）与矩阵驱动 —— 刻意不复制判定逻辑，
 * 否则「原型绿、守卫红」时你分不清是规则错了还是原型写歪了。
 *
 * ## 纪律
 *
 * - 零外部依赖（只 require `fs` / `path` + 仓库内相对路径）
 * - 确定性（`--all` 的每个场景都带固定 `today`，不看系统时间）
 * - 只读（`--scan` / `--audit-clean` 不写任何文件）
 * - 每个场景只隔离**一个**行为，`clean` 场景必须 0 error 0 warning（证明不是无脑拦）
 */

'use strict';

const path = require('path');

const guard = require('../../../scripts/lib/buildRootGuard');

const BUILD_ROOT = guard.BUILD_ROOT;

// ── 夹具：一份「全部合规」的登记表 ──────────────────────────────────────────
// 每个反例场景都是它的浅拷贝 + 一处覆写，这样场景之间的差异就是被隔离的那个行为。

const FIXTURE_REGISTRY = {
  meta: { root: BUILD_ROOT, version: '1.0.0', parasiticBudget: 6 },
  outputs: [
    { id: 'ai-frontend', path: 'entries/ai-frontend', rebuild: 'npm run build --prefix apps/ai-frontend', inBuildAll: true, status: 'active' },
    { id: 'backend-dist', path: 'entries/backend', rebuild: 'node packaging/build/esbuild-modules.js', inBuildAll: true, status: 'active' },
    { id: 'electron', path: 'entries/electron', rebuild: 'electron-builder', inBuildAll: true, status: 'active' },
    { id: 'flutter-android', path: 'entries/flutter-android', rebuild: 'flutter build apk', inBuildAll: true, status: 'active' },
    { id: 'pip', path: 'entries/pip', rebuild: 'python -m build --outdir entries/pip', inBuildAll: true, status: 'active' },
    { id: 'moonbit', path: 'kernel/moonbit/_build', rebuild: 'moon build', parasitic: true, hook: 'moon build（工具强制路径）', sunset: '2027-06-30', legacyPath: 'kernel/moonbit/_build' },
    { id: 'frontend-vendor', path: 'apps/ai-frontend/public/vendor', rebuild: 'sync-md-vendor.mjs', parasitic: true, hook: 'predev/prebuild', sunset: '2026-12-31', legacyPath: 'apps/ai-frontend/public/vendor' },
    { id: 'md-vendor', path: 'extensions/tools/khy-markdown/vendor', rebuild: 'ensure-vendor.mjs', parasitic: true, hook: 'prepack', sunset: '2026-12-31', legacyPath: 'extensions/tools/khy-markdown/vendor' },
    { id: 'ai-frontend-dist-legacy', path: 'entries/ai-frontend', legacyPath: 'apps/ai-frontend/dist', rebuild: 'npm run build --prefix apps/ai-frontend', inBuildAll: true, status: 'migrating', sunset: '2026-10-31' },
  ],
};

/** 基础夹具 + 按 id 覆写条目。 */
function withOutputs(patch) {
  return {
    meta: { ...FIXTURE_REGISTRY.meta },
    outputs: FIXTURE_REGISTRY.outputs.map((o) => ({ ...o, ...(patch[o.id] || {}) })),
  };
}

const SCENARIOS = {
  // ★ 应放行：全部落产物根、全部已登记、寄生都在有效期内。
  clean: {
    label: 'clean（应放行）',
    paths: ['entries/ai-frontend', 'entries/backend', 'entries/electron', 'entries/flutter-android', 'entries/pip', 'kernel/moonbit/_build', 'apps/ai-frontend/public/vendor', 'extensions/tools/khy-markdown/vendor'],
    registry: FIXTURE_REGISTRY,
    today: '2026-09-16',
  },
  // 新产物又落在源码树里 —— 规则要拦的正是这个。
  'scatter-new': {
    label: 'scatter-new（新增散落产物）',
    paths: ['entries/ai-frontend', 'apps/provider-hub/dist', 'services/backend/dist'],
    registry: FIXTURE_REGISTRY,
    today: '2026-09-16',
  },
  // 产物根下自创子目录、未登记。
  unregistered: {
    label: 'unregistered（产物根下未登记）',
    paths: ['entries/ai-frontend', 'entries/someone-made-this-up'],
    registry: FIXTURE_REGISTRY,
    today: '2026-09-16',
  },
  // 产物根下套太深。
  'depth-exceeded': {
    label: 'depth-exceeded（产物根下嵌套过深）',
    paths: ['entries/ai-frontend/dist/assets/inner'],
    registry: FIXTURE_REGISTRY,
    today: '2026-09-16',
  },
  // 寄生条目过期未续期。
  'parasitic-expired': {
    label: 'parasitic-expired（寄生豁免过期）',
    paths: ['apps/ai-frontend/public/vendor', 'extensions/tools/khy-markdown/vendor'],
    registry: FIXTURE_REGISTRY,
    today: '2027-06-01',
  },
  // 寄生条目没写重建钩子 —— 删了就回不来。
  'parasitic-no-hook': {
    label: 'parasitic-no-hook（寄生条目缺重建钩子）',
    paths: ['kernel/moonbit/_build'],
    registry: withOutputs({ moonbit: { hook: '' } }),
    today: '2026-09-16',
  },
  // 声明 migrated 但磁盘还在 —— 迁移没做完，或构建又写回了旧位置。
  'legacy-not-removed': {
    label: 'legacy-not-removed（声明迁完但旧路径仍在）',
    paths: ['apps/ai-frontend/dist'],
    registry: withOutputs({ 'ai-frontend-dist-legacy': { status: 'migrated' } }),
    today: '2026-09-16',
  },
  // 迁移中的历史路径：允许存在，只报 warning。
  'legacy-migrating': {
    label: 'legacy-migrating（迁移中，应只告警）',
    paths: ['apps/ai-frontend/dist'],
    registry: FIXTURE_REGISTRY,
    today: '2026-09-16',
  },
  // 登记表自身：缺 rebuild —— 不可重建就不许进产物根。
  'registry-missing-rebuild': {
    label: 'registry-missing-rebuild（登记表缺重建命令）',
    paths: ['entries/broken'],
    registry: {
      meta: { root: BUILD_ROOT, parasiticBudget: 6 },
      outputs: [{ id: 'broken', path: 'entries/broken', inBuildAll: true, status: 'active' }],
    },
    today: '2026-09-16',
  },
  // 登记表自身：未纳入 build:all —— 删了就重建不回来。
  'registry-not-in-build-all': {
    label: 'registry-not-in-build-all（未纳入一键重建）',
    paths: [],
    registry: {
      meta: { root: BUILD_ROOT, parasiticBudget: 6 },
      outputs: [{ id: 'x', path: 'entries/x', rebuild: 'echo x', status: 'active' }],
    },
    today: '2026-09-16',
  },
  // 非寄生条目却写在产物根外 —— 登记表自己越界。
  'registry-entry-outside-root': {
    label: 'registry-entry-outside-root（登记条目越界）',
    paths: [],
    registry: {
      meta: { root: BUILD_ROOT, parasiticBudget: 6 },
      outputs: [{ id: 'y', path: 'apps/y/dist', rebuild: 'echo y', inBuildAll: true, status: 'active' }],
    },
    today: '2026-09-16',
  },
  // 寄生预算被撑破 —— 棘轮只降不升。
  'parasitic-budget': {
    label: 'parasitic-budget（寄生条目超出预算）',
    paths: [],
    registry: {
      meta: { root: BUILD_ROOT, parasiticBudget: 1 },
      outputs: [
        { id: 'a', path: 'kernel/moonbit/_build', rebuild: 'moon build', parasitic: true, hook: 'moon build', sunset: '2027-06-30' },
        { id: 'b', path: 'apps/ai-frontend/public/vendor', rebuild: 'x', parasitic: true, hook: 'predev', sunset: '2027-06-30' },
      ],
    },
    today: '2026-09-16',
  },
};

// ── CLI ──────────────────────────────────────────────────────────────────

function runScenario(s) {
  const scanned = guard.inspect(s.paths, s.registry, { today: s.today });
  const table = guard.inspectRegistry(s.registry);
  return { checked: scanned.checked, findings: [...scanned.findings, ...table.findings] };
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const scenarioArg = argv.find((a) => a.startsWith('--scenario='));
  const filesArg = argv.find((a) => a.startsWith('--files='));
  const wantScan = argv.includes('--scan');
  const wantAudit = argv.includes('--audit-clean');
  const wantAll = argv.includes('--all');

  const results = [];

  if (wantAll || scenarioArg) {
    const names = scenarioArg ? [scenarioArg.slice('--scenario='.length)] : Object.keys(SCENARIOS);
    for (const name of names) {
      const s = SCENARIOS[name];
      if (!s) {
        console.error(`未知场景：${name}；可用：${Object.keys(SCENARIOS).join(' ')}`);
        process.exit(2);
      }
      results.push({ name, label: s.label, ...runScenario(s) });
    }
  } else if (filesArg) {
    const paths = filesArg
      .slice('--files='.length)
      .split(',')
      .map((x) => (x.includes(':') ? x.slice(x.indexOf(':') + 1) : x))
      .map(guard.norm)
      .filter(Boolean);
    const scanned = guard.inspect(paths, FIXTURE_REGISTRY, { today: '2026-09-16' });
    results.push({
      name: 'custom',
      label: `自定义（${paths.length} 条）`,
      checked: scanned.checked,
      findings: scanned.findings,
    });
  } else if (wantScan || wantAudit) {
    const cli = require('../../../scripts/ci/check-build-root.js');
    const disk = cli.scanDisk();
    if (wantAudit) {
      const a = cli.auditCleanRegistry();
      if (asJson) {
        console.log(JSON.stringify(a, null, 2));
      } else {
        console.log('── clean.js 清理登记表体检（I1 可删除性）');
        console.log(`  声明条目：${a.declared} 条　磁盘产物候选：${a.disk.length} 个`);
        console.log(`  被登记覆盖：${a.covered} 个　登记管不到的：${a.gaps.length} 个`);
        console.log('');
        for (const g of a.gaps) console.log(`  [GAP] ${g}`);
        console.log('');
        console.log(`  Summary: ${a.gaps.length} gap(s).（判据：gap 必须为 0）`);
      }
      process.exit(a.gaps.length ? 1 : 0);
    }
    const { registry } = cli.readRegistry();
    const scanned = guard.inspect(disk, registry, { today: new Date().toISOString().slice(0, 10) });
    const table = guard.inspectRegistry(registry);
    results.push({
      name: 'scan',
      label: `真实仓库扫描（${disk.length} 个产物候选目录）`,
      checked: scanned.checked,
      findings: [...scanned.findings, ...table.findings],
    });
  } else {
    console.log('用法：node _产物/build-root-demo.js --all | --scenario=<name> | --scan | --audit-clean | --files="A:path,B:path"');
    console.log('场景：' + Object.keys(SCENARIOS).join(' '));
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      console.log(guard.render(r, r.label));
      console.log('');
    }
  }

  const anyError = results.some((r) => r.findings.some((f) => f.severity === 'error'));
  process.exit(anyError ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { SCENARIOS, FIXTURE_REGISTRY, withOutputs };
