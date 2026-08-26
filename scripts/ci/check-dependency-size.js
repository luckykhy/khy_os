#!/usr/bin/env node
/**
 * 依赖体积预算（零依赖、跨平台）。
 *
 *   node scripts/ci/check-dependency-size.js            # 报告态：打表，永远 exit 0
 *   node scripts/ci/check-dependency-size.js --strict   # 超预算则 exit 1
 *   node scripts/ci/check-dependency-size.js --update   # 用当前实测值重写基线
 *   node scripts/ci/check-dependency-size.js --no-bytes # 只算包数，跳过磁盘度量（快）
 *
 * ## 为什么「包数」是硬预算而「字节」只是报告
 *
 * 包数从 package-lock.json 推导，同一份锁文件在任何机器上都算出同一个数，
 * 适合当阻断条件。磁盘字节则不然：npm 的提升结果受安装顺序影响，optional
 * 依赖按平台挑（@esbuild/* 有二十多个平台包，一台机器只落一个），Windows 的
 * CRLF 还会把文本文件撑大。把字节当阻断条件，等于让门禁在「换台机器跑」时
 * 随机失败。所以字节走容差 + 报告，包数走硬预算。
 *
 * ## 三条预算线
 *
 *   dev    完整开发安装（npm ci）—— 锁文件里全部非 link 条目
 *   prod   生产安装（npm ci --omit=dev）—— 锁文件里 dev !== true 的条目
 *   bundle 发布产物 dist/khy-os-bundle.mjs —— pip 与 npm 两个渠道实际发出去的
 *          东西，它不含 node_modules，是「用户侧真实体积」的唯一诚实指标
 *
 * ## 报告什么
 *
 *   最大依赖      按体积排序的前 N 族
 *   增长量        每条预算线给出 基线 → 当前 的差值与百分比
 *   触发增长的包  当前直接依赖里、基线快照中没有的那些，也就是本次 PR 加的包
 *   可选 peer     peerDependenciesMeta.optional 的数量与增删名单。零字节，不进硬预算，
 *                 但它是「代码能 require 什么」的完整清单 —— 加一条就多一条运行时分支
 *
 * ## 两种 node_modules 布局，度量方式不同
 *
 * 脚本自动识别当前是哪一种，并把结果记进基线的 layout 字段。布局变了，字节就没有
 * 可比性，脚本会明说而不是闷头对比两个数量级的数。
 *
 *   npm 平铺    包摊在 node_modules 顶层 —— 直接遍历顶层目录（scope 下钻一层）。
 *   pnpm 严格   顶层只有本 manifest 的直接依赖软链 + .pnpm 虚拟存储。真实内容全在
 *               node_modules/.pnpm/<name>@<ver>_<peers>/node_modules/<name>，
 *               同级的其它条目是指向别的虚拟目录的软链。所以遍历 .pnpm，每个虚拟
 *               目录只取那一个**非软链**的真实包目录，一个包实例算一次，不重复计。
 *
 * pnpm 模式下这个字节数的含义要说清：.pnpm 里的文件是**硬链**到全局 store 的，
 * 所以它衡量的是「这套依赖有多重」，不是「删掉能腾出多少磁盘」。真要腾磁盘得
 * pnpm store prune，而且多个仓库共享同一个 store。
 *
 * ## 计数源为什么还是 package-lock.json
 *
 * 仓库的 workspace 安装入口已经是 pnpm（见 pnpm-workspace.yaml 与根 package.json
 * 的 //packageManager），但 package-lock.json 仍被跟踪、仍与各 manifest 保持一致，
 * 而且它是**平铺**结构，一个条目就是一个包，数起来无歧义。pnpm-lock.yaml 的
 * snapshots 是内容寻址的，同一个包在不同 peer 组合下会出现多条，数出来的绝对值
 * 与「装了多少个包」不是一回事，做趋势预算反而更难解释。
 *
 * 两边的真实闭包都量过（2026-08-25）：
 *   npm  全量开发 1514 包 / backend 生产 455 包
 *   pnpm 全量开发 1396 包 / backend 生产 403 包
 * 差值来自 pnpm 不做幻影提升。趋势方向一致，所以用哪边当预算源都能挡住膨胀。
 *
 * **如果将来 package-lock.json 退役**，把 countFromLock() 换成走 pnpm-lock.yaml 的
 * importers -> snapshots 闭包遍历（需要一个 YAML 解析器，届时脚本不再是零依赖），
 * 并重新 --update 一次基线，不要试图沿用现在的数字。
 *
 * 基线文件：scripts/ci/dependency-size-baseline.json（人可读、可 review、进版本库）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(__dirname, 'dependency-size-baseline.json');
const LOCK_PATH = path.join(ROOT, 'package-lock.json');

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const update = argv.includes('--update');
const noBytes = argv.includes('--no-bytes');
const topN = (() => {
  const flag = argv.find((a) => a.startsWith('--top='));
  const n = flag ? Number(flag.slice('--top='.length)) : 15;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15;
})();

const toPosix = (p) => p.split(path.sep).join('/');
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
const signed = (n) => (n >= 0 ? '+' : '') + n;
const pct = (cur, base) => (base === 0 ? 0 : ((cur - base) / base) * 100);

/**
 * 参与「直接依赖」统计的 manifest。
 *
 * 必须覆盖 pnpm-workspace.yaml 的**全部**成员 + 仓库根，否则漏掉的成员里新增重依赖
 * 时，「触发增长的包」那一栏点不出来，预算就成了摆设。
 * 加/删 workspace 成员时同步改这里（改完跑 --update 重建 directTotal）。
 */
const MANIFESTS = [
  'package.json',
  'services/backend/package.json',
  'services/ai-backend/package.json',
  'apps/ai-frontend/package.json',
  'apps/khy-mobile/package.json',
  'software/khyquant/frontend/package.json',
  'platform/packages/shared/package.json',
  'platform/packages/ui-shared/package.json',
  'extensions/tools/khy-markdown/package.json',
];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * 可选 peer（peerDependenciesMeta.optional）单独统计，**不进硬预算**。
 *
 * 理由：.npmrc 的 auto-install-peers=false 让它们一个字节都不装，拿它们撑预算会把
 * 「声明了一个可选能力」误判成「依赖变重了」。但也不能不报 —— 它们是「代码可以
 * require 的东西」的完整清单，加一条就是多一条运行时可能走到的分支。所以走报告态：
 * 数量 + 增减名单照打，只是不参与阻断。
 */
function collectOptionalPeers() {
  const snapshot = {};
  for (const rel of MANIFESTS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const pj = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const meta = pj.peerDependenciesMeta || {};
    const names = Object.keys(meta)
      .filter((n) => meta[n] && meta[n].optional)
      .sort();
    if (names.length) snapshot[rel] = names;
  }
  return snapshot;
}

// ── 包数：从锁文件推导，与机器无关 ──────────────────────────────────

function countFromLock() {
  if (!fs.existsSync(LOCK_PATH)) {
    console.error('[dep-size] 找不到 package-lock.json。');
    console.error(
      '[dep-size] 若它已随 pnpm 迁移退役，请按脚本头部说明把计数源换成 pnpm-lock.yaml 并重建基线。'
    );
    process.exit(2);
  }
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const packages = lock.packages || {};
  let dev = 0;
  let prod = 0;
  let optional = 0;
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '' || !key.includes('node_modules/')) continue; // 根条目与 workspace 自身
    if (entry.link) continue; // workspace 软链，不占额外空间
    if (entry.dev) dev += 1;
    else prod += 1;
    if (entry.optional) optional += 1;
  }
  return { devPackages: dev + prod, prodPackages: prod, optionalPackages: optional };
}

// ── 字节：本机实测，仅作报告 ────────────────────────────────────────

function sizeOf(abs) {
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return 0;
  }
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) total += sizeOf(path.join(abs, e.name));
  return total;
}

/**
 * 收集一个 node_modules 目录下的真实包（scope 下钻一层）。
 * 软链一律跳过：npm 布局下它是 workspace 回链，pnpm 布局下它是指向别的虚拟目录的边，
 * 两种情况计进来都是重复计数。
 */
function collectPackages(nmDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // .pnpm / .bin / .package-lock.json
    if (e.isSymbolicLink()) continue;
    const abs = path.join(nmDir, e.name);
    if (e.name.startsWith('@')) {
      let subs = [];
      try {
        subs = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of subs) {
        if (s.isSymbolicLink()) continue;
        out.push([e.name + '/' + s.name, sizeOf(path.join(abs, s.name))]);
      }
    } else if (e.isDirectory()) {
      out.push([e.name, sizeOf(abs)]);
    }
  }
  return out;
}

/** 当前 node_modules 是 pnpm 严格布局还是 npm 平铺布局。 */
function detectLayout(rootNm) {
  return fs.existsSync(path.join(rootNm, '.pnpm')) ? 'pnpm' : 'npm';
}

/**
 * 哪些 workspace 成员真的装出了 node_modules。
 *
 * 这条信息必须跟着字节一起报：包数是从锁文件数的，覆盖**全部**成员；字节是从磁盘量的，
 * 只覆盖**装了的**成员。仓库支持按需安装（install:core / install:frontend / install:mobile），
 * 所以两者口径天然可能不一致 —— 不写出来，后面看基线的人会把它们当成同一个范围。
 */
function materializedWorkspaces() {
  const present = [];
  const absent = [];
  for (const rel of MANIFESTS) {
    if (rel === 'package.json') continue; // 根不是 workspace 成员
    const dir = path.dirname(rel);
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    (fs.existsSync(path.join(ROOT, dir, 'node_modules')) ? present : absent).push(dir);
  }
  return { present, absent };
}

/**
 * pnpm 严格布局：真实内容在 .pnpm/<key>/node_modules/<name>。
 * 每个虚拟目录里只有一个非软链条目（就是该包本身），其余是依赖软链。
 */
function measurePnpmStore(rootNm) {
  const store = path.join(rootNm, '.pnpm');
  const out = [];
  let keys;
  try {
    keys = fs.readdirSync(store, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const k of keys) {
    if (!k.isDirectory() || k.isSymbolicLink()) continue;
    collectPackages(path.join(store, k.name, 'node_modules'), out);
  }
  return out;
}

/** 按当前布局度量整棵依赖树。 */
function measureTree(rootNm, layout) {
  return layout === 'pnpm' ? measurePnpmStore(rootNm) : collectPackages(rootNm, []);
}

/**
 * 发布产物：packaging/build/esbuild-modules.js 产出的 6 份模块 bundle。
 *
 * pip 与 npm 两个渠道发出去的就是这些 bundle.mjs，**不含 node_modules**，
 * 所以它们才是「用户侧真实体积」的诚实指标。
 *
 * 注意体积随构建模式差一大截：不带 --prod 是未压缩的开发产物，带 --prod 才压缩。
 * 基线记 mode，模式不一致时不做对比 —— 拿压缩产物比未压缩产物只会得到假结论。
 */
function measureBundles() {
  const dir = path.join(ROOT, 'dist', 'modules');
  const out = [];
  let ids;
  try {
    ids = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of ids) {
    if (!d.isDirectory()) continue;
    const f = path.join(dir, d.name, 'bundle.mjs');
    try {
      out.push([d.name, fs.statSync(f).size]);
    } catch {
      /* 该模块未构建，跳过 */
    }
  }
  return out.sort((a, b) => b[1] - a[1]);
}
/** 按 scope 归并，便于看清「一族包」的总代价（@babel/*、@opentelemetry/* 之类）。 */
function groupByScope(list) {
  const acc = new Map();
  for (const [name, bytes] of list) {
    const key = name.startsWith('@') ? name.split('/')[0] + '/*' : name;
    acc.set(key, (acc.get(key) || 0) + bytes);
  }
  return [...acc.entries()].sort((a, b) => b[1] - a[1]);
}

// ── 直接依赖快照：用来指认「是哪个包把预算撑爆的」 ───────────────────

function collectDirectDeps() {
  const snapshot = {};
  for (const rel of MANIFESTS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const pj = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const names = new Set();
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(pj[field] || {})) names.add(name);
    }
    snapshot[rel] = [...names].sort();
  }
  return snapshot;
}

function diffDirectDeps(baseSnapshot, curSnapshot) {
  const added = [];
  const removed = [];
  const base = baseSnapshot || {};
  const keys = new Set([...Object.keys(base), ...Object.keys(curSnapshot)]);
  for (const k of keys) {
    const before = new Set(base[k] || []);
    const after = new Set(curSnapshot[k] || []);
    for (const n of after) if (!before.has(n)) added.push(k + ': ' + n);
    for (const n of before) if (!after.has(n)) removed.push(k + ': ' + n);
  }
  return { added: added.sort(), removed: removed.sort() };
}

// ── 主流程 ──────────────────────────────────────────────────────────

const counts = countFromLock();
const direct = collectDirectDeps();
const directTotal = Object.values(direct).reduce((s, l) => s + l.length, 0);
const optionalPeers = collectOptionalPeers();
const optionalPeerTotal = Object.values(optionalPeers).reduce((s, l) => s + l.length, 0);

const rootNm = path.join(ROOT, 'node_modules');
const hasTree = fs.existsSync(rootNm);
const layout = hasTree ? detectLayout(rootNm) : null;
let treeBytes = 0;
let largest = [];
if (!noBytes && hasTree) {
  largest = measureTree(rootNm, layout);
  treeBytes = largest.reduce((s, [, n]) => s + n, 0);
}

const bundles = measureBundles();
const bundleBytes = bundles.reduce((s, [, n]) => s + n, 0);

if (!fs.existsSync(BASELINE_PATH) && !update) {
  console.error('[dep-size] 基线文件不存在：' + toPosix(path.relative(ROOT, BASELINE_PATH)));
  console.error('[dep-size] 先执行：node scripts/ci/check-dependency-size.js --update');
  process.exit(2);
}

const baseline = fs.existsSync(BASELINE_PATH)
  ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  : { tolerancePct: 5, budgets: {}, directDeps: {} };

const tolerance = Number(baseline.tolerancePct);
if (!update && (!Number.isFinite(tolerance) || tolerance <= 0)) {
  console.error('[dep-size] 基线文件的 tolerancePct 必须是正数');
  process.exit(2);
}

const b = baseline.budgets || {};
let exceeded = 0;

console.log(
  '[dep-size] 包数以 package-lock.json 为准（硬预算）；字节为本机实测（容差 ' +
    tolerance +
    '%，仅报告）'
);
console.log('');

/**
 * 打印一条预算线。
 * @param hard true = 只要超过基线就算超预算；false = 超过容差百分比才算
 */
function line(label, cur, base, unit, hard) {
  if (!Number.isFinite(base) || base === 0) {
    console.log('  ' + label.padEnd(28) + '基线未登记 → 当前 ' + unit(cur));
    return;
  }
  const d = cur - base;
  const p = pct(cur, base);
  const over = hard ? cur > base : p > tolerance;
  console.log(
    '  ' +
      label.padEnd(28) +
      '基线 ' +
      unit(base) +
      ' → 当前 ' +
      unit(cur) +
      '  (' +
      signed(d) +
      ', ' +
      signed(p.toFixed(2)) +
      '%)' +
      (over ? '   ⚠ 超预算' : '')
  );
  if (over) exceeded += 1;
}

console.log('开发安装（全部 workspace 成员）');
line('依赖包数', counts.devPackages, Number(b.devPackages), (n) => n + ' 个', true);
if (noBytes || !hasTree) {
  console.log(
    '  node_modules 实测           未度量（' + (hasTree ? '--no-bytes' : '目录不存在') + '）'
  );
} else if (baseline.layout && baseline.layout !== layout) {
  // 布局换了，两个数不是一回事，硬对比只会给出一个吓人的假百分比。
  console.log(
    '  node_modules 实测           基线记录的是 ' +
      baseline.layout +
      ' 布局，当前是 ' +
      layout +
      ' 布局 → 字节不可比'
  );
  console.log('                              当前实测 ' + mb(treeBytes) + '（' + largest.length + ' 个真实包目录）');
  console.log('                              确认布局迁移完成后跑 --update 重建字节基线。');
} else {
  line('node_modules 实测', treeBytes, Number(b.devBytes), mb, false);
  const ws = materializedWorkspaces();
  console.log(
    '                              布局 ' +
      layout +
      '，' +
      largest.length +
      ' 个真实包目录' +
      (layout === 'pnpm' ? '（.pnpm 内容硬链到全局 store，删掉不等于腾出这么多磁盘）' : '')
  );
  if (ws.absent.length) {
    // 按需安装是本仓库的正常用法，这里不是告警，是给字节数标清适用范围。
    console.log(
      '                              字节只覆盖已安装的 ' +
        ws.present.length +
        ' 个 workspace；未安装：' +
        ws.absent.join('、')
    );
    console.log('                              （包数来自锁文件，覆盖全部成员 —— 两者口径不同，不要相减）');
  }
}

console.log('');
console.log('生产安装（npm ci --omit=dev）');
line('依赖包数', counts.prodPackages, Number(b.prodPackages), (n) => n + ' 个', true);
console.log('  其中 optional               ' + counts.optionalPackages + ' 个（按平台挑，不会全装）');

console.log('');
console.log('发布产物（dist/modules/*/bundle.mjs —— pip 与 npm 实际发出去的东西）');
if (bundles.length) {
  line('' + bundles.length + ' 份 bundle 合计', bundleBytes, Number(b.bundleBytes), mb, false);
  for (const [id, bytes] of bundles) {
    console.log('    ' + mb(bytes).padStart(9) + '  ' + id);
  }
  console.log('    体积随构建模式变化：--prod 压缩，不带则不压缩。基线与当前须同模式才可比。');
} else {
  console.log('  未构建，跳过。重建：node packaging/build/esbuild-modules.js [--prod]');
}

console.log('');
console.log('直接依赖');
line('声明总数', directTotal, Number(b.directTotal), (n) => n + ' 个', true);

const { added, removed } = diffDirectDeps(baseline.directDeps, direct);
if (added.length) {
  console.log('');
  console.log('  ⚠ 新增直接依赖 ' + added.length + ' 个 —— 这就是「触发增长的包」：');
  for (const a of added) console.log('      + ' + a);
  console.log('      新增大体积依赖需在 PR 里说明：体积、有无更小替代、是否平台专属、能否按需加载。');
}
if (removed.length) {
  console.log('  · 移除直接依赖 ' + removed.length + ' 个：');
  for (const r of removed) console.log('      - ' + r);
}

// 可选 peer 单独一栏、只报告不阻断。它们零字节（auto-install-peers=false），拿来撑硬预算
// 会把「声明了一个可选能力」误报成「依赖变重了」；但每加一个就是多一条运行时可能 require
// 到的分支，所以增删照样逐个点名。
console.log('  可选 peer（零字节）' + String(optionalPeerTotal).padStart(11) + ' 个');
const peerDiff = diffDirectDeps(baseline.optionalPeers, optionalPeers);
for (const a of peerDiff.added) console.log('      + ' + a);
for (const r of peerDiff.removed) console.log('      - ' + r);
if (peerDiff.added.length) {
  console.log(
    '      新增可选 peer 必须在 require 失败的分支里打印中文、可照做的安装提示（见 CONTRIBUTING §11.2）。'
  );
}

if (!noBytes && hasTree && largest.length) {
  console.log('');
  console.log('最大依赖 Top ' + topN + '（按族归并，' + layout + ' 布局实测）');
  for (const [name, bytes] of groupByScope(largest).slice(0, topN)) {
    console.log('  ' + mb(bytes).padStart(9) + '  ' + name);
  }
}

console.log('');

if (update) {
  const next = {
    ...baseline,
    measuredAt: new Date().toISOString().slice(0, 10),
    // 字节基线是在哪种布局下量出来的。布局变了字节不可比，报告态会明说。
    ...(noBytes || !hasTree ? {} : { layout }),
    tolerancePct: Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 5,
    budgets: {
      ...b,
      devPackages: counts.devPackages,
      prodPackages: counts.prodPackages,
      directTotal,
      ...(noBytes || !hasTree ? {} : { devBytes: treeBytes }),
      ...(bundleBytes ? { bundleBytes } : {}),
    },
    directDeps: direct,
    // 不放进 budgets：它是名单而非预算，越界不阻断。
    optionalPeers,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('[dep-size] 已更新基线：' + toPosix(path.relative(ROOT, BASELINE_PATH)));
  process.exit(0);
}

if (exceeded > 0) {
  console.log(
    '[dep-size] ' + exceeded + ' 项超出预算。确认必要后用 --update 更新基线，并在 PR 描述里写清代价。'
  );
  process.exit(strict ? 1 : 0);
}

console.log('[dep-size] 全部在预算内。');
process.exit(0);
