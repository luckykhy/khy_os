#!/usr/bin/env node
/**
 * MoonBit 模块布局检查（零依赖，不需要安装 moon 工具链）。
 *
 *   node scripts/ci/check-moonbit-layout.js            # 报告态，永远 exit 0
 *   node scripts/ci/check-moonbit-layout.js --strict   # 有问题则 exit 1
 *   node scripts/ci/check-moonbit-layout.js --json     # 机器可读
 *
 * 为什么需要它：MoonBit 要求**每个包含 .mbt 源文件的目录都必须有 moon.pkg.json**
 * 才会被当成一个 package 编译。缺了它，源文件不会报错，而是**根本不参与构建** ——
 * 这是最难发现的一类问题：`moon build` 退出码为 0，但你以为写好的模块并没有被编译。
 *
 * 本检查不需要 moon 工具链，因此可以在任何 runner 上无条件运行，作为 MoonBit
 * 相关改动的第一道确定性关卡。真正的编译由 native-ci.yml 里安装 moon 后执行。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');

const SKIP_DIRS = new Set(['node_modules', '.git', '_build', 'target', 'dist', '.moon']);
const toPosix = (p) => p.split(path.sep).join('/');

/** 递归找出所有 moon.mod.json（每个都是一个 MoonBit module 根）。 */
function findModules(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      findModules(path.join(dir, e.name), acc);
    } else if (e.isFile() && e.name === 'moon.mod.json') {
      acc.push(dir);
    }
  }
  return acc;
}

/** 收集模块内每个目录的 .mbt 文件数与是否有 moon.pkg.json。 */
function scanModule(moduleDir) {
  const dirs = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const mbt = entries.filter((e) => e.isFile() && e.name.endsWith('.mbt')).map((e) => e.name);
    const hasPkg = entries.some((e) => e.isFile() && e.name === 'moon.pkg.json');
    if (mbt.length > 0 || hasPkg) {
      dirs.push({ dir, mbt, hasPkg });
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
    }
  })(moduleDir);
  return dirs;
}

const modules = findModules(ROOT, []).sort();
const report = [];

for (const moduleDir of modules) {
  const rel = toPosix(path.relative(ROOT, moduleDir));
  let name = rel;
  try {
    name = JSON.parse(fs.readFileSync(path.join(moduleDir, 'moon.mod.json'), 'utf8')).name || rel;
  } catch {
    /* 清单读不动就退回目录名，不因此中断整体检查 */
  }
  const dirs = scanModule(moduleDir);
  const orphans = dirs.filter((d) => d.mbt.length > 0 && !d.hasPkg);
  const emptyPkgs = dirs.filter((d) => d.hasPkg && d.mbt.length === 0);
  report.push({
    module: rel,
    name,
    packages: dirs.filter((d) => d.hasPkg).length,
    orphanDirs: orphans.map((d) => ({
      dir: toPosix(path.relative(ROOT, d.dir)),
      mbtFiles: d.mbt.sort(),
    })),
    emptyPackageDirs: emptyPkgs.map((d) => toPosix(path.relative(ROOT, d.dir))),
  });
}

if (asJson) {
  console.log(JSON.stringify({ modules: report }, null, 2));
} else {
  console.log(`[moonbit] 发现 ${report.length} 个模块（moon.mod.json）`);
  console.log('');
  for (const m of report) {
    const bad = m.orphanDirs.length;
    console.log(`${bad ? '✗' : '✓'} ${m.module}  (${m.name})  声明的 package 数：${m.packages}`);
    for (const o of m.orphanDirs) {
      console.log(`    ✗ ${o.dir} 有 ${o.mbtFiles.length} 个 .mbt 但缺 moon.pkg.json`);
      console.log(`      ${o.mbtFiles.join(', ')}`);
    }
    for (const d of m.emptyPackageDirs) {
      console.log(`    · ${d} 有 moon.pkg.json 但没有 .mbt（空包，通常无害）`);
    }
  }
  console.log('');
}

const totalOrphans = report.reduce((s, m) => s + m.orphanDirs.length, 0);
const badModules = report.filter((m) => m.orphanDirs.length > 0).length;

if (totalOrphans === 0) {
  console.log('[moonbit] 布局正常：每个含 .mbt 的目录都声明为 package。');
  process.exit(0);
}

console.log(
  `[moonbit] ${badModules} 个模块存在共 ${totalOrphans} 个未声明目录。` +
    '这些目录里的 .mbt 不会被编译，且 moon build 不会报错。'
);
console.log('[moonbit] 修法：在每个目录放一个 moon.pkg.json，例如：');
console.log('[moonbit]   {"import": []}                     # 库包');
console.log('[moonbit]   {"is-main": true, "import": []}     # 可执行包（有 main 函数）');
process.exit(strict ? 1 : 0);
