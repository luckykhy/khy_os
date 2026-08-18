#!/usr/bin/env node
/**
 * 仓库层级/结构守卫 —— [DESIGN-ARCH-068] 仓库层级板块规范 的强制执行者。
 *
 * Usage:
 *   node scripts/ci/check-repo-layout.js
 *   node scripts/ci/check-repo-layout.js --strict-warnings
 *   node scripts/ci/check-repo-layout.js --promote=root-whitelist,docs-index-first,layer-registry
 *   node scripts/ci/check-repo-layout.js --list=cross-layer-require,unresolved-require
 *   node scripts/ci/check-repo-layout.js --update-baseline
 *
 * 与 check-change-safety.js 共用一套 finding 形态（id / severity / --promote /
 * --strict-warnings / 未知 id 退 2）。本脚本刻意**全仓扫描**而非 --changed：
 * 层级是仓库的全局属性，只看改动集会漏掉「别人搬走了索引文件」这类破坏。
 *
 * 真源关系（改本脚本必须同步改文档，否则守卫与规范会各说各话）：
 *   - 层级清单 L0-L6 与横切层  → docs/03_DESIGN_设计/[DESIGN-ARCH-068] 仓库层级板块规范.md 第一节
 *   - 根目录封闭白名单          → docs/08_MGMT_项目管理/[MGMT-STD-001] 项目文档结构与索引铁律规范.md 第 1.3 条
 *   - docs/ 索引首位铁律        → 同上 第 2.1/2.2 条与 CP-5
 *   - 任务入口命名与「每个入口须有脚本」→ [DESIGN-ARCH-068] 第五节
 *
 * HOW-TO-EXTEND（给维护者/小模型）：
 *   新增一条规则 = ①写一个 checkXxx(findings) 函数；②把 finding id 加进 ALL_FINDING_IDS；
 *   ③若是 warning-with-baseline 型，把 id 加进 BASELINE_IDS 并在 baseline json 里补一项；
 *   ④在 scripts/tests/check-repo-layout.test.js 补用例。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = process.env.KHY_REPO_LAYOUT_ROOT
  // 仅供 scripts/tests/check-repo-layout.test.js 指向临时 fixture 仓库使用。
  // 规则逻辑必须能脱离本仓库当时的真实状态被验证，否则「基线一改测试就绿」。
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const updateBaseline = args.includes('--update-baseline');
const promotedIds = new Set(
  args
    .filter(arg => arg.startsWith('--promote='))
    .flatMap(arg => arg.slice('--promote='.length).split(','))
    .map(id => id.trim())
    .filter(Boolean)
);

const BASELINE_PATH = path.join(repoRoot, 'scripts', 'ci', 'repo-layout-baseline.json');

// --list=<id,id>：把这些 finding 的**全量**清单打出来（默认只打前几条预览）。
// 修存量违规时需要完整名单，翻 CI 日志比重跑一次便宜。
const listIds = new Set(
  args
    .filter(arg => arg.startsWith('--list='))
    .flatMap(arg => arg.slice('--list='.length).split(','))
    .map(id => id.trim())
    .filter(Boolean)
);

const ALL_FINDING_IDS = new Set([
  'root-whitelist',
  'docs-index-first',
  'layer-registry',
  'dangling-task',
  'cross-layer-require',
  'unresolved-require',
  'docs-index-complete',
]);

// 这几条是「已知违规存量 + 只降不升」型：超过基线才升为 error。
const BASELINE_IDS = new Set([
  'dangling-task',
  'cross-layer-require',
  'unresolved-require',
  'docs-index-complete',
]);

// ── 层级清单（真源 [DESIGN-ARCH-068] 第一节）────────────────────────────────
const LAYERS = {
  kernel: 'L0 手写 OS 内核',
  platform: 'L1 Python 启动器 + 共享包 + 交付',
  services: 'L2 Node 运行时（全部业务逻辑）',
  apps: 'L3 平台自带管理前端',
  software: 'L4 跑在平台之上的内置应用',
  extensions: 'L5 外部 IDE 桥接',
  tools: 'L6 独立开发者工具',
};
// 横切层：服务于所有层，不参与依赖判定（真源同上 第 1.2 节）。
const CROSSCUTTING = {
  docs: '全部文档',
  scripts: '工程任务脚本',
  packaging: '打包清单与板块切分',
  alpine: 'Alpine 镜像 etc 覆盖层',
  _source: '加密源码快照与恢复说明',
};
// 构建/打包工具在仓库根生成的目录，不是源码层。保持封闭集合，新增项须有对应忽略规则。
const GENERATED_TOP_LEVEL_DIRS = new Set(['build', 'dist', 'khy_os.egg-info']);

// ── 根目录白名单（真源 [MGMT-STD-001] 第 1.3 条，封闭、严禁扩张）──────────────
// 说明性文件白名单：README 及其语言变体 + 平台/工具链按根路径强制加载的文件。
const ROOT_DOC_WHITELIST = new Set([
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'AGENTS.md',
  'CLAUDE.md',
  'khy.md',
]);
const README_VARIANT_RE = /^README(?:\.[A-Za-z-]+)?\.md$/;
// 只有 .md / .txt 属「说明性文件」范畴；其余扩展名（.json/.toml/.bat/.sh…）不在本规则内。
const ROOT_DOC_EXT_RE = /\.(?:md|txt)$/i;

// ── 跨层深引用（真源 [DESIGN-ARCH-068] 第二节禁止边）─────────────────────────
// workspace 根：一个 require 若从文件所在 workspace 根逃出去，就是跨包深引用。
const WORKSPACE_ROOTS = [
  'services/backend',
  'services/ai-backend',
  'apps/ai-frontend',
  'software/khyquant',
  'software/khyquant/frontend',
  'platform/packages/shared',
  'platform/packages/moonbit-plugin-sdk',
  'platform/delivery',
  'tools/khyos-markdown',
  'tools/deepseek-eyes',
  'extensions/khy-trae-bridge',
];

function git(cmdArgs) {
  try {
    return cp.execFileSync('git', cmdArgs, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

// ── 规则 1：根目录说明性文件白名单（CP-1）──────────────────────────────────
function checkRootWhitelist(findings) {
  const offenders = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => ROOT_DOC_EXT_RE.test(name))
    .filter(name => !ROOT_DOC_WHITELIST.has(name) && !README_VARIANT_RE.test(name))
    .sort();

  if (offenders.length === 0) return;
  findings.push({
    id: 'root-whitelist',
    severity: 'error',
    message: `根目录有 ${offenders.length} 个白名单外的说明性文件（[MGMT-STD-001] 第 1.1/1.2 条，CP-1）。`,
    detail: `须收容进 docs/ 对应子目录：${offenders.join(', ')}`,
    full: offenders,
  });
}

// ── 规则 2：docs/ 分类目录须有排序首位的 00_INDEX_*（第 2.1/2.2 条，CP-5）────
// 只查 docs/ 的一级子目录，且只查「直接含 .md 的目录」——这样 _assets/（纯资产）
// 与 _ref/（爬取样本）不会被误判，无需维护特例名单。
function checkDocsIndexFirst(findings) {
  const docsRoot = path.join(repoRoot, 'docs');
  if (!fs.existsSync(docsRoot)) return;

  const missing = [];
  const notFirst = [];
  for (const entry of fs.readdirSync(docsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(docsRoot, entry.name);
    const names = fs.readdirSync(dir).sort();
    const markdown = names.filter(n => n.toLowerCase().endsWith('.md'));
    if (markdown.length === 0) continue;

    const indexes = markdown.filter(n => n.startsWith('00_INDEX_'));
    if (indexes.length === 0) {
      missing.push(`docs/${entry.name}/`);
      continue;
    }
    if (markdown[0] !== indexes[0]) {
      notFirst.push(`docs/${entry.name}/ (首位是 ${markdown[0]})`);
    }
  }

  if (missing.length > 0) {
    findings.push({
      id: 'docs-index-first',
      severity: 'error',
      message: `${missing.length} 个 docs/ 分类目录缺总领索引 00_INDEX_*（[MGMT-STD-001] 第 2.1 条，CP-4）。`,
      detail: missing.join(', '),
    });
  }
  if (notFirst.length > 0) {
    findings.push({
      id: 'docs-index-first',
      severity: 'error',
      message: `${notFirst.length} 个 docs/ 分类目录的索引未居字典序首位（第 2.2 条，CP-5）。`,
      detail: notFirst.join(', '),
    });
  }
}

// ── 规则 2.5：主索引须列全每个阶段目录的文档（[MGMT-STD-001] CP-3）──────────
// 规则 2 只管「每个目录有没有就近索引」，管不到「主入口 docs/00_INDEX_文档索引.md
// 有没有漏链」。实测漏链是三位数量级，故走 warning + 基线只降不升，而不是一次性硬门。
//
// 匹配方式：主索引里的链接是百分号编码的（`%5B` = `[`、`%20` = 空格），
// 先把这三种还原再做纯文本包含判断。只要文件名在页面任意处出现（链接或正文提及）
// 就算「已列」——本规则查的是**可达性**，不是链接语法是否规范。
const MASTER_INDEX_REL = 'docs/00_INDEX_文档索引.md';
const STAGE_DIR_RE = /^\d{2}_/;
// 02/09 两个小白向目录**刻意不**要求主索引逐篇点名：它们的可达性由另一条守卫
// scripts/docs/check_beginner_docs.js（`npm run docs:check-beginner`）保证——
// 禁孤儿页、禁死链、禁无导航死胡同页，比「主索引里有没有这一行」更强。
// 主索引只链它们的目录入口。改动此豁免须同步改 [MGMT-STD-001] CP-3 的落地说明。
const MASTER_INDEX_EXEMPT_DIRS = new Set(['02_CONCEPTS_概念入门', '09_STORY_修仙学AI']);

function decodeIndexText(raw) {
  return raw
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']')
    .replace(/%20/gi, ' ');
}

function checkDocsIndexComplete(findings, counts) {
  const masterPath = path.join(repoRoot, MASTER_INDEX_REL);
  const docsRoot = path.join(repoRoot, 'docs');
  counts['docs-index-complete'] = 0;
  if (!fs.existsSync(masterPath) || !fs.existsSync(docsRoot)) return;

  const text = decodeIndexText(fs.readFileSync(masterPath, 'utf8'));
  const stageDirs = fs
    .readdirSync(docsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && STAGE_DIR_RE.test(entry.name))
    .filter(entry => !MASTER_INDEX_EXEMPT_DIRS.has(entry.name))
    .map(entry => entry.name)
    .sort();

  const missing = [];
  const perStage = {};
  for (const dir of stageDirs) {
    let dirMissing = 0;
    for (const name of fs.readdirSync(path.join(docsRoot, dir)).sort()) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      // 就近索引自身不必被主索引逐个点名（主索引按阶段分区链接正文文档）。
      if (name.startsWith('00_INDEX_')) continue;
      if (text.includes(name)) continue;
      missing.push(`docs/${dir}/${name}`);
      dirMissing += 1;
    }
    if (dirMissing > 0) perStage[dir] = dirMissing;
  }

  counts['docs-index-complete'] = missing.length;
  if (missing.length === 0) return;

  const breakdown = Object.entries(perStage)
    .map(([dir, n]) => `${dir} ${n}`)
    .join(' / ');
  findings.push({
    id: 'docs-index-complete',
    severity: 'warning',
    message: `${missing.length} 份阶段文档没有出现在主索引 ${MASTER_INDEX_REL} 里（CP-3 漏链）。`,
    detail:
      `分布：${breakdown}。就近 00_INDEX_* 比主索引完整，排查时以就近索引为准；` +
      `全量名单用 --list=docs-index-complete。`,
    full: missing,
  });
}


function checkLayerRegistry(findings) {
  const known = new Set([...Object.keys(LAYERS), ...Object.keys(CROSSCUTTING)]);
  const unregistered = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    // 点目录（.git/.github/.khy…）、node_modules 与声明过的生成目录不属层级体系。
    .filter(name => !name.startsWith('.') && name !== 'node_modules')
    .filter(name => !GENERATED_TOP_LEVEL_DIRS.has(name))
    .filter(name => !known.has(name))
    .sort();

  if (unregistered.length === 0) return;
  findings.push({
    id: 'layer-registry',
    severity: 'error',
    message: `${unregistered.length} 个顶层目录未登记在层级清单里。`,
    detail:
      `${unregistered.join(', ')} —— 要新增顶层目录，先改 ` +
      `docs/03_DESIGN_设计/[DESIGN-ARCH-068] 仓库层级板块规范.md 第一节，再改本脚本的 LAYERS / CROSSCUTTING。`,
  });
}

// ── 规则 4：npm run 目标须能解析到已定义脚本 ──────────────────────────────
function collectDefinedScripts() {
  const defined = new Set();
  const manifests = git(['ls-files', '*package.json'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => !p.includes('node_modules/'));

  for (const rel of manifests) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      for (const name of Object.keys(parsed.scripts || {})) defined.add(name);
    } catch {
      /* 坏 json 由 check:json-schemas 负责，这里不重复报 */
    }
  }
  return defined;
}

function collectReferencedTasks() {
  const out = git(['grep', '-I', '-o', '-h', '-E', 'npm run [a-zA-Z0-9:_-]+']);
  const referenced = new Map(); // target -> count
  for (const line of out.split('\n')) {
    const match = line.match(/npm run ([a-zA-Z0-9:_-]+)/);
    if (!match) continue;
    const target = match[1];
    // `npm run --workspace …` 之类的 flag 形态不是目标名。
    if (target.startsWith('-')) continue;
    referenced.set(target, (referenced.get(target) || 0) + 1);
  }
  return referenced;
}

function checkDanglingTasks(findings, counts) {
  const defined = collectDefinedScripts();
  const referenced = collectReferencedTasks();
  const dangling = [...referenced.keys()].filter(t => !defined.has(t)).sort();
  counts['dangling-task'] = dangling.length;
  if (dangling.length === 0) return;

  const preview = dangling.slice(0, 12).join(', ');
  findings.push({
    id: 'dangling-task',
    severity: 'warning',
    message: `${dangling.length} 个被引用的 npm run 目标没有对应脚本定义（[DESIGN-ARCH-068] 第 5.1 节）。`,
    detail: `${preview}${dangling.length > 12 ? ` …（共 ${dangling.length} 个，全量用 --list=dangling-task）` : ''}`,
    full: dangling,
  });
}

// ── 规则 5：跨 workspace 的深层相对 require ───────────────────────────────
function workspaceRootOf(relFile) {
  // 取最长匹配，使 software/khyquant/frontend 优先于 software/khyquant。
  let best = null;
  for (const root of WORKSPACE_ROOTS) {
    if (relFile === root || relFile.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

// 纯 re-export 壳文件：整个文件（去掉注释与空行）就是一句
// `module.exports = require('…')`。这是仓库里刻意的**兼容别名**手法 ——
// services/backend 保持自己的稳定路径，实现归 software/khyquant 所有。
// 它不引入逻辑耦合，只是一个路径别名，所以不计入 cross-layer-require；
// 但仍会做存在性校验（落到 unresolved-require），因为壳指空是必崩的。
const SHIM_CACHE = new Map();
function isPureReexportShim(relFile) {
  if (SHIM_CACHE.has(relFile)) return SHIM_CACHE.get(relFile);
  let verdict = false;
  try {
    const body = fs
      .readFileSync(path.join(repoRoot, relFile), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('//'))
      .join(' ');
    verdict = /^module\.exports\s*=\s*require\((['"])[^'"]+\1\);?$/.test(body);
  } catch {
    verdict = false;
  }
  SHIM_CACHE.set(relFile, verdict);
  return verdict;
}

// require 目标能否解析到磁盘上真实存在的东西（Node 的 CJS 解析顺序简化版）。
function resolvesOnDisk(relTarget) {
  const base = path.join(repoRoot, relTarget);
  const candidates = [base, `${base}.js`, `${base}.json`, `${base}.node`, `${base}.cjs`];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
    } catch { /* 忽略 */ }
  }
  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      return ['index.js', 'index.json', 'package.json'].some(n => fs.existsSync(path.join(base, n)));
    }
  } catch { /* 忽略 */ }
  return false;
}

// git grep 按行匹配，会把注释里举例的 require 也抓进来（本仓库注释里大量引用
// 路径做说明）。只用行内特征排除，够用且零依赖：行首是 // 或 *（块注释续行）
// 或 #，或者 // 出现在 require( 之前。
function looksLikeComment(rawLine, requireIndex) {
  const trimmed = rawLine.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')) {
    return true;
  }
  const lineComment = rawLine.indexOf('//');
  return lineComment >= 0 && lineComment < requireIndex;
}

function isTestFixture(relFile) {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/.test(relFile)
    || /(?:^|\.)test\.[cm]?js$/.test(relFile);
}

function checkCrossLayerRequires(findings, counts) {
  const out = git([
    'grep',
    '-n',
    '-I',
    '-E',
    "require\\(['\"](\\.\\./){2,}",
    '--',
    'services',
    'apps',
    'software',
    'platform',
    'tools',
    'extensions',
  ]);

  const offenders = [];
  const unresolved = [];
  let shimCount = 0;

  for (const line of out.split('\n')) {
    if (!line.trim() || line.includes('node_modules/')) continue;
    const firstColon = line.indexOf(':');
    const secondColon = line.indexOf(':', firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const file = toPosix(line.slice(0, firstColon));
    // 这条规则约束可发布的运行时模块图。测试可直接加载相邻 workspace 的
    // fixture / implementation 做契约验证，不会形成产品运行时依赖边。
    if (isTestFixture(file)) continue;
    const lineNo = line.slice(firstColon + 1, secondColon);
    const body = line.slice(secondColon + 1);

    const specMatch = body.match(/require\(['"]((?:\.\.\/){2,}[^'"]*)['"]\)?/);
    if (!specMatch) continue;
    if (looksLikeComment(body, specMatch.index)) continue;
    const spec = specMatch[1];

    const wsRoot = workspaceRootOf(file);
    if (!wsRoot) continue;

    // 解析 require 目标，判断是否逃出了 workspace 根。
    const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
    const escapes = !(resolved === wsRoot || resolved.startsWith(`${wsRoot}/`));

    // 指向不存在的路径 = 潜伏崩溃（多半是搬文件时 ../ 少算/多算一级）。
    // 惰性 require（写在函数体里）不会在启动期暴露，只在跑到那条命令时炸。
    if (!resolvesOnDisk(resolved)) {
      unresolved.push(`${file}:${lineNo} → ${resolved}（不存在）`);
      continue;
    }

    if (!escapes) continue;

    if (isPureReexportShim(file)) {
      shimCount += 1;
      continue;
    }
    offenders.push(`${file}:${lineNo} → ${resolved}`);
  }

  counts['cross-layer-require'] = offenders.length;
  counts['unresolved-require'] = unresolved.length;
  if (shimCount > 0) counts['_reexport-shims'] = shimCount;

  if (offenders.length > 0) {
    findings.push({
      id: 'cross-layer-require',
      severity: 'warning',
      message: `${offenders.length} 处跨 workspace 的深层相对 require（[DESIGN-ARCH-068] 第二节禁止边）。`
        + `${shimCount > 0 ? ` 另有 ${shimCount} 处纯 re-export 壳文件按兼容别名豁免。` : ''}`,
      detail: `应改为 workspace 包名（如 @khy/shared）。首例：${offenders.slice(0, 3).join(' | ')}`,
      full: offenders,
    });
  }

  if (unresolved.length > 0) {
    findings.push({
      id: 'unresolved-require',
      severity: 'warning',
      message: `${unresolved.length} 处深层相对 require 指向磁盘上不存在的路径（潜伏崩溃）。`,
      detail: `多为搬迁文件时 ../ 级数算错；惰性 require 只在跑到那条命令时才炸。首例：${unresolved.slice(0, 4).join(' | ')}`,
      full: unresolved,
    });
  }
}

// ── 基线 ────────────────────────────────────────────────────────────────
function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function main() {
  const unknown = [...promotedIds, ...listIds].filter(id => !ALL_FINDING_IDS.has(id));
  if (unknown.length > 0) {
    console.error(`check-repo-layout: 未知的 --promote / --list id: ${unknown.join(', ')}`);
    console.error(`  可用 id: ${[...ALL_FINDING_IDS].join(', ')}`);
    process.exit(2);
  }

  const findings = [];
  const counts = {};

  checkRootWhitelist(findings);
  checkDocsIndexFirst(findings);
  checkDocsIndexComplete(findings, counts);
  checkLayerRegistry(findings);
  checkDanglingTasks(findings, counts);
  checkCrossLayerRequires(findings, counts);

  if (updateBaseline) {
    // 保留 baseline json 里 `_` 前缀的说明字段（_note/_source/_meaning），
    // 否则每次下调基线都会把「只降不升」这条约定的解释顺手删掉。
    const prev = loadBaseline() || {};
    const next = {};
    for (const [k, v] of Object.entries(prev)) {
      if (k.startsWith('_')) next[k] = v;
    }
    next.updated = new Date().toISOString().slice(0, 10);
    next.counts = {};
    for (const id of BASELINE_IDS) next.counts[id] = counts[id] || 0;
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(`check-repo-layout: 基线已更新 → ${toPosix(path.relative(repoRoot, BASELINE_PATH))}`);
    console.log(`  ${JSON.stringify(next.counts)}`);
    return;
  }

  const baseline = loadBaseline();
  const regressions = [];
  for (const id of BASELINE_IDS) {
    const allowed = baseline && baseline.counts && Number.isInteger(baseline.counts[id])
      ? baseline.counts[id]
      : null;
    const actual = counts[id] || 0;
    if (allowed === null) continue;
    if (actual > allowed) regressions.push({ id, allowed, actual });
  }

  // 基线只降不升：超出即升为 error（这才是棘轮，不然基线只是个数字）。
  const effectiveSeverity = (finding) => {
    if (finding.severity !== 'warning') return finding.severity;
    if (finding.id && promotedIds.has(finding.id)) return 'error';
    if (regressions.some(r => r.id === finding.id)) return 'error';
    if (strictWarnings) return 'error';
    return 'warning';
  };

  console.log('check-repo-layout: 层级/结构守卫（真源 [DESIGN-ARCH-068] + [MGMT-STD-001]）');
  console.log(`counts: ${JSON.stringify(counts)}`);
  if (baseline && baseline.counts) {
    console.log(`baseline: ${JSON.stringify(baseline.counts)} (updated ${baseline.updated || 'n/a'})`);
  } else {
    console.log('baseline: 缺失 —— 跑 node scripts/ci/check-repo-layout.js --update-baseline 建立');
  }

  if (findings.length === 0) {
    console.log('result: 无结构发现，层级规范全绿。');
  } else {
    console.log('result:');
    for (const finding of findings) {
      const eff = effectiveSeverity(finding);
      const mark = eff !== finding.severity ? ` (promoted from ${finding.severity})` : '';
      console.log(` - [${eff}]${mark} ${finding.message} (id: ${finding.id})`);
      if (finding.detail) console.log(`   ${finding.detail}`);
      if (listIds.has(finding.id) && Array.isArray(finding.full)) {
        for (const item of finding.full) console.log(`     · ${item}`);
      }
    }
  }

  for (const r of regressions) {
    console.error(`check-repo-layout: ${r.id} 超出基线（基线 ${r.allowed}，实测 ${r.actual}）—— 只允许下降。`);
    console.error('  修掉新增违规，或在确有正当理由时用 --update-baseline 显式下调/记录。');
  }

  if (findings.some(finding => effectiveSeverity(finding) === 'error')) {
    process.exit(1);
  }
}

main();
