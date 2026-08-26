#!/usr/bin/env node
/**
 * @pattern Command
 *
 * 构建与测试产物清理（零依赖、跨平台、默认干跑）。
 *
 *   npm run clean                      # 干跑：只列出将删除的目录与实测体积，什么都不删
 *   npm run clean:apply                # 真删（等价于 node scripts/maintenance/clean.js --apply）
 *   node scripts/maintenance/clean.js --apply --include-vendor   # 连可再生的 vendor 一起删
 *   node scripts/maintenance/clean.js --group=build              # 只清某一组
 *
 * ## 为什么是白名单而不是 glob
 *
 * 清理脚本最容易出的事故不是「少删了」而是「多删了」，而 glob（`**\/dist`、
 * `**\/build`）恰好是最容易多删的写法：`node_modules` 里有几十个包自带 dist/，
 * kernel/ 下的 build/ 混着编译产物与手工维护的链接脚本，`.khy/checkpoints` 是
 * 用户跑出来的、删了不可再生的现场。所以这里只认**逐条登记的相对路径**，每条
 * 都必须写清「它是什么产物」和「怎么重建」——重建命令写不出来的，就不该进这张表。
 *
 * ## 与 slim-down.{sh,bat} 的分工
 *
 * 那两个脚本清的是**运行时残留**（应用日志、sqlite 的 wal/shm、kernel 的 .o 与
 * 磁盘镜像、node-llama-cpp 用不到的平台二进制），本脚本一条都不碰，两边不重叠。
 * 本脚本清的是**构建与测试产物**，也就是 2026-08-25 依赖体积基线里量到的那
 * ~280 MB：dist/ 139 MB + android build 120 MB + 前端 dist 18 MB + build/ 18 MB。
 *
 * ## 绝不删除
 *
 * 见 PROTECTED。源码、锁文件、node_modules、.git、用户配置（~/.khyquant）、
 * 凭据（.khy/credentials）、检查点（.khy/checkpoints，实测 50 MB 且不可再生）、
 * 审计轨迹（.khy/audit-trajectory）。任何登记路径若命中 PROTECTED 或解析后
 * 逃出仓库根，脚本直接以 exit 2 拒绝运行——那是登记表写错了，不是运行时异常。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * 清理登记表。每条：
 *   rel    仓库根下的相对路径
 *   group  分组；build = 默认清理，vendor = 需 --include-vendor 才清
 *   what   它是什么
 *   rebuild 怎么把它变回来（写不出来的不许登记）
 */
const TARGETS = [
  {
    rel: 'dist',
    group: 'build',
    what: 'Python sdist/wheel 与 dist/modules 下的 6 份模块 bundle',
    rebuild: 'node packaging/build/esbuild-modules.js（模块 bundle）/ scripts/release/publish-dual.sh（sdist+wheel）',
  },
  {
    rel: 'build',
    group: 'build',
    what: 'setuptools 的中间目录（build/lib、build/bdist.*）',
    rebuild: 'python -m build（或任一次 pip wheel 构建）',
  },
  {
    rel: 'apps/khy-mobile/android/app/build',
    group: 'build',
    what: 'Gradle 构建缓存与 APK 中间产物',
    rebuild: 'cd apps/khy-mobile/android && ./gradlew assembleDebug',
  },
  {
    rel: 'apps/ai-frontend/dist',
    group: 'build',
    what: 'ai-frontend 的 Vite 产物',
    rebuild: 'npm run build --prefix apps/ai-frontend',
  },
  {
    rel: 'software/khyquant/frontend/dist',
    group: 'build',
    what: 'khyquant 前端的 Vite 产物',
    rebuild: 'npm run build --prefix software/khyquant/frontend',
  },
  {
    rel: 'coverage',
    group: 'build',
    what: '根级覆盖率报告',
    rebuild: 'npm run quality:pr（覆盖率环节自动生成）',
  },
  {
    rel: 'services/backend/coverage',
    group: 'build',
    what: 'backend 覆盖率报告',
    rebuild: 'cd services/backend && npx jest --coverage',
  },
  {
    rel: '.nyc_output',
    group: 'build',
    what: 'c8/nyc 的原始覆盖率数据',
    rebuild: '同上，跑一次带覆盖率的测试即可',
  },
  {
    rel: '.cache',
    group: 'build',
    what: '治理脚本的分析缓存（quality-gate、dangling-docs、rename-map 等）',
    rebuild: '下次运行对应检查脚本时自动重建，只是第一次会慢一点',
  },
  {
    rel: 'extensions/tools/khy-markdown/vendor',
    group: 'vendor',
    what: 'muya WYSIWYG 引擎（约 11 MB，不进 git）',
    rebuild: 'node extensions/tools/khy-markdown/muya-embed/ensure-vendor.mjs',
  },
  {
    rel: 'docs/_assets/mermaid.min.js',
    group: 'vendor',
    what: '文档站 Mermaid 引擎（约 3.3 MB，不进 git）',
    rebuild: 'npm run docs:mermaid',
  },
];

/**
 * 保护清单（子树级）：这些路径本身、以及它们下面的任何东西，都不允许登记。
 * 这里放的是「删了要么不可再生、要么直接毁掉环境」的东西。
 */
const PROTECTED_SUBTREE = [
  '.git',
  '.github',
  '.khy/checkpoints',
  '.khy/audit-trajectory',
  '.khy/credentials',
  'node_modules',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

/**
 * 保护清单（精确级）：这些**目录本身**不允许登记，但目录内部的构建产物可以
 * （apps/ai-frontend/dist、services/backend/coverage 就在这些目录里面）。
 * 这里放的是分层目录与源码根，防止有人手滑写成 `rel: 'services'`。
 */
const PROTECTED_EXACT = [
  'src',
  'kernel',
  'platform',
  'services',
  'apps',
  'software',
  'extensions',
  'tools',
  'scripts',
  'docs',
  'packaging',
];

const toPosix = (p) => p.split(path.sep).join('/');
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const includeVendor = argv.includes('--include-vendor');
const onlyGroup = (() => {
  const flag = argv.find((a) => a.startsWith('--group='));
  return flag ? flag.slice('--group='.length) : null;
})();

/**
 * 校验一条登记路径是否合法。
 * @returns {string|null} 违规原因；null 表示合法
 */
function validate(rel) {
  const abs = path.resolve(ROOT, rel);
  const inside = path.relative(ROOT, abs);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return `解析后逃出仓库根：${abs}`;
  }
  const posix = toPosix(inside);
  for (const guard of PROTECTED_SUBTREE) {
    // 前缀比较必须带 '/'，否则 'node_modules' 会误伤 'node_modules_old'。
    if (posix === guard || posix.startsWith(guard + '/')) {
      return `位于受保护子树 ${guard} 之下`;
    }
  }
  if (PROTECTED_EXACT.includes(posix)) {
    return `是受保护的目录本身：${posix}（只能登记它内部的构建产物）`;
  }
  return null;
}

/** 递归量一个路径的字节数（文件直接返回大小）。 */
function sizeOf(abs) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) {
    return 0; // 不跟随软链，也不计它的目标体积
  }
  if (stat.isFile()) {
    return stat.size;
  }
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    total += sizeOf(path.join(abs, e.name));
  }
  return total;
}

// ── 先整表校验，任何一条不合法就整体拒绝，绝不「跳过坏的、删好的」 ──
const violations = [];
for (const t of TARGETS) {
  const why = validate(t.rel);
  if (why) {
    violations.push(`${t.rel}: ${why}`);
  }
}
if (violations.length) {
  console.error('[clean] 登记表校验失败，未删除任何内容：');
  for (const v of violations) {
    console.error('  - ' + v);
  }
  process.exit(2);
}

const groups = new Set(['build']);
if (includeVendor) {
  groups.add('vendor');
}
const selected = TARGETS.filter(
  (t) => (onlyGroup ? t.group === onlyGroup : groups.has(t.group))
);

if (!selected.length) {
  console.error(`[clean] 没有匹配的清理组（--group=${onlyGroup}）。可用：build, vendor`);
  process.exit(2);
}

console.log(
  `[clean] 模式：${apply ? '真删（--apply）' : '干跑（不加 --apply 不会删任何东西）'}` +
    `　组：${[...new Set(selected.map((t) => t.group))].join(', ')}`
);
console.log('');

let present = 0;
let totalBytes = 0;
let removed = 0;
let failed = 0;

for (const t of selected) {
  const abs = path.join(ROOT, t.rel);
  if (!fs.existsSync(abs)) {
    console.log(`  ·  ${t.rel}  —  不存在，跳过`);
    continue;
  }
  present += 1;
  const bytes = sizeOf(abs);
  totalBytes += bytes;
  console.log(`  ${apply ? '✂' : '·'}  ${t.rel}  —  ${mb(bytes)}`);
  console.log(`       内容：${t.what}`);
  console.log(`       重建：${t.rebuild}`);

  if (apply) {
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`       ⚠ 删除失败（${message}）——多半是文件被占用，先停掉 khy 进程再试。`);
    }
  }
}

console.log('');
if (!present) {
  console.log('[clean] 登记的产物一个都不存在，无事可做。');
  process.exit(0);
}

if (apply) {
  console.log(`[clean] 已删除 ${removed}/${present} 项，释放约 ${mb(totalBytes)}${failed ? `（${failed} 项失败）` : ''}。`);
  if (!includeVendor) {
    console.log('[clean] 未清理 vendor 组（muya 引擎、mermaid 引擎）。需要时加 --include-vendor。');
  }
  process.exit(failed ? 1 : 0);
}

console.log(`[clean] 干跑结束：${present} 项存在，合计约 ${mb(totalBytes)}。执行 npm run clean:apply 才会真删。`);
process.exit(0);
