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
  'extension-contract',
  'extension-id-hardcode',
  'extension-path-drift',
]);

// 这几条是「已知违规存量 + 只降不升」型：超过基线才升为 error。
const BASELINE_IDS = new Set([
  'dangling-task',
  'cross-layer-require',
  'unresolved-require',
  'docs-index-complete',
  'extension-contract',
  'extension-id-hardcode',
  'extension-path-drift',
]);

// ── 层级清单（真源 [DESIGN-ARCH-068] 第一节）────────────────────────────────
const LAYERS = {
  kernel: 'L0 手写 OS 内核',
  platform: 'L1 Python 启动器 + 共享包 + 交付',
  services: 'L2 Node 运行时（全部业务逻辑）',
  apps: 'L3 平台自带管理前端',
  software: 'L4 跑在平台之上的内置应用',
  extensions: 'L5 内置拓展（随主包分发，契约见 [DESIGN-ARCH-069]）',
  tools: 'L6 独立开发者工具',
};
// 横切层：服务于所有层，不参与依赖判定（真源同上 第 1.2 节）。
const CROSSCUTTING = {
  docs: '全部文档',
  scripts: '工程任务脚本',
  packaging: '打包清单与板块切分',
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
  'extensions/tools/khy-markdown',
  'tools/deepseek-eyes',
  'extensions/bridges/khy-trae-bridge',
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

// ── 规则 8：extensions/ 下每个目录都须遵守拓展契约 ────────────────────────
// 真源 docs/03_DESIGN_设计/[DESIGN-ARCH-069] 拓展契约与核心边界规范.md 第三节。
// 字段清单同时在 services/backend/src/services/extensions/extensionRoots.js 落地；
// 这里刻意**不 require** 那个模块 —— 守卫属横切层，按 [DESIGN-ARCH-068] 第二节
// 「任何层 → L5/L6」的禁止边，scripts/ 只许按路径操作，不许 import L2 的实现。
// 代价是两处各有一份字段名，收益是守卫不会因为被守卫的代码坏掉而一起坏掉。
const EXTENSION_MANIFEST = 'khy.extension.json';
const EXTENSION_KINDS = new Set(['runtime', 'ide-bridge', 'asset', 'toolchain']);

// 仓库自己的分类名白名单（真源 [DESIGN-ARCH-069] §2.3 的表；来自用户原话枚举的六类：
// tool / plugin / scripts / mcp / software / 协议）。
//
// 加载器**不**认这份表 —— 它只认「有没有 manifest」，任何空壳目录都能当分类（见
// extensionRoots 的 MAX_DEPTH 注释）。收敛分类名纯属**仓库卫生**：不收的话
// extensions/ 会长出一棵谁也说不清的树，而那正是本契约要消灭的东西。用户目录与
// KHY_EXTENSION_PATH 下的拓展不受这条约束 —— 那是别人的磁盘，不是本仓的卫生。
const EXTENSION_CATEGORIES = new Set(['tools', 'protocols', 'mcp', 'scripts', 'software', 'bridges']);

function listSubdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !name.startsWith('.') && name !== 'node_modules')
      .sort();
  } catch {
    return [];
  }
}

/**
 * 枚举 extensions/ 下的拓展目录，深度与 extensionRoots.discover() 一致（两层，§2.3）。
 *
 * 刻意重复实现而不 require 那个模块：守卫属横切层，按 [DESIGN-ARCH-068] 第二节的禁止边
 * scripts/ 不许 import L2 的实现 —— 代价是两份深度逻辑，收益是守卫不会因为被守卫的
 * 代码坏掉而一起坏掉。两处的一致性由 contribToolLifecycle.test.js 的分类用例组兜住。
 *
 * 与加载器的一处**刻意差异**：这里用「manifest 文件存在」判定是不是拓展，加载器用
 * 「manifest 可解析」。于是 JSON 写坏的目录在加载器眼里退化成分类目录（下面没东西 →
 * 静默消失），在守卫眼里仍是一个坏拓展 —— 该报出来，而不是跟着一起消失。
 *
 * @returns {{extensions: Array<{rel:string,abs:string,id:string,category:string|null}>,
 *           structural: string[]}} structural 是布局本身的违规（分类名越界、说不清的目录）
 */
function collectExtensionDirs(extRoot) {
  const extensions = [];
  const structural = [];
  for (const name of listSubdirs(extRoot)) {
    const abs = path.join(extRoot, name);
    if (fs.existsSync(path.join(abs, EXTENSION_MANIFEST))) {
      // 自带 manifest → 是拓展，不再下探（与加载器同一优先级：显式声明胜过结构推断）
      extensions.push({ rel: `extensions/${name}`, abs, id: name, category: null });
      continue;
    }
    const children = listSubdirs(abs);
    const inner = children.filter(c => fs.existsSync(path.join(abs, c, EXTENSION_MANIFEST)));
    if (inner.length === 0) {
      structural.push(
        `extensions/${name} —— 既不是拓展（缺 ${EXTENSION_MANIFEST}）也不是分类目录（下面没有任何拓展）`
      );
      continue;
    }
    if (!EXTENSION_CATEGORIES.has(name)) {
      structural.push(
        `extensions/${name} —— 分类名不在 ${[...EXTENSION_CATEGORIES].join(' / ')} 内`
      );
    }
    for (const child of children) {
      const childAbs = path.join(abs, child);
      if (!inner.includes(child)) {
        structural.push(
          `extensions/${name}/${child} —— 缺 ${EXTENSION_MANIFEST}；` +
            `分类目录下只能直接放拓展，不能再套一层分类（发现只下探两层）`
        );
        continue;
      }
      extensions.push({
        rel: `extensions/${name}/${child}`,
        abs: childAbs,
        id: child,
        category: name,
      });
    }
  }
  return { extensions, structural };
}

function checkExtensionContract(findings, counts) {
  const extRoot = path.join(repoRoot, 'extensions');
  if (!fs.existsSync(extRoot)) {
    counts['extension-contract'] = 0;
    return; // 没有 extensions/ 目录 → 无可违规（fixture 仓库的常态）
  }
  const { extensions, structural } = collectExtensionDirs(extRoot);

  const violations = [...structural];
  for (const { rel, abs, id: name } of extensions) {
    const manifestPath = path.join(abs, EXTENSION_MANIFEST);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      violations.push(
        `${rel} —— ${err.code === 'ENOENT' ? `缺 ${EXTENSION_MANIFEST}` : `${EXTENSION_MANIFEST} 不是合法 JSON`}`
      );
      continue;
    }
    if (!manifest || typeof manifest !== 'object') {
      violations.push(`${rel} —— ${EXTENSION_MANIFEST} 顶层不是对象`);
      continue;
    }
    // id 必须等于**叶子**目录名：否则「删目录即消失」的键就藏在文件内容里，孤儿检测
    // 无从核对。分类名刻意不进 id（§2.3）—— 移进分类目录不得改变拓展身份。
    if (manifest.id !== name) {
      violations.push(`${rel} —— id (${JSON.stringify(manifest.id)}) 与目录名不一致`);
    }
    const kind = manifest.kind === undefined ? 'runtime' : manifest.kind;
    if (!EXTENSION_KINDS.has(kind)) {
      violations.push(`${rel} —— kind (${JSON.stringify(manifest.kind)}) 不在 ${[...EXTENSION_KINDS].join(' / ')} 内`);
    } else if (kind === 'runtime') {
      // runtime 拓展的入口必须现在就能解析到：一个指向空气的 main 只会在首次调用
      // 时才暴露，而那时报的是「未知命令」，没人会想到是 manifest 写错了。
      if (typeof manifest.main !== 'string' || !manifest.main) {
        violations.push(`${rel} —— kind=runtime 但没声明 main`);
      } else if (!fs.existsSync(path.join(abs, manifest.main))) {
        violations.push(`${rel} —— main (${manifest.main}) 在磁盘上不存在`);
      }
    } else if (kind === 'toolchain') {
      // toolchain 的入口不是 main 而是 commands[].script（核经 ext-run 起子进程调它）。
      // 这里必须现在就核对：ext-run 只有在**用户真的敲了那条命令**时才会发现脚本不存在，
      // 而那通常是发布当天。manifest 说得出名字就得指得出脚本。
      for (const cmd of Array.isArray(manifest.commands) ? manifest.commands : []) {
        if (!cmd || typeof cmd.name !== 'string' || !cmd.name) {
          violations.push(`${rel} —— commands 里有一条没有 name`);
          continue;
        }
        if (typeof cmd.script !== 'string' || !cmd.script) {
          violations.push(`${rel} —— kind=toolchain 的命令 "${cmd.name}" 没声明 script`);
        } else if (!fs.existsSync(path.join(abs, cmd.script))) {
          violations.push(`${rel} —— 命令 "${cmd.name}" 的 script (${cmd.script}) 在磁盘上不存在`);
        }
      }
    }
  }

  counts['extension-contract'] = violations.length;
  if (violations.length === 0) return;
  findings.push({
    id: 'extension-contract',
    severity: 'warning',
    message: `${violations.length} 处 extensions/ 目录不合拓展契约。`,
    detail:
      `${violations.slice(0, 3).join('；')}${violations.length > 3 ? ' …' : ''} —— 契约见 ` +
      `docs/03_DESIGN_设计/[DESIGN-ARCH-069] 拓展契约与核心边界规范.md 第三节；` +
      `全量清单用 --list=extension-contract。`,
    full: violations,
  });
}

// ── 规则：核里不得硬编码拓展 id ──────────────────────────
// 真源 [DESIGN-ARCH-069] §1.3 第四条：「核里**不允许**出现任何拓展 id 的硬编码分支」。
//
// 为什么需要机器强制：这条此前靠人守，而人没守住 —— khy-markdown 一个拓展就在核里
// 积了**三份**互不认识的定位逻辑，其中 docs.js 那份在拓展迁目录后指向空气，
// 而 fail-soft 把失败掩成一句提示，`khy docs browse` 静默坏了一整轮无人发觉。
// 硬编码一个 id 的代价不是「不够优雅」，是下一次移动时多一处会烂掉的路径。
//
// **只算分派用途的字面量**。注释与面向用户的提示文案不算：一句「未找到 khy-markdown
// 拓展」不是分支，禁掉它只会逼人把有用的错误信息写模糊，对架构没有任何好处。
// 判据是字面量是否出现在**代码**里（剥掉注释后仍在）且**不在字符串拼接的提示上下文**。
const CORE_SCAN_DIRS = ['services/backend/src'];
// 允许名单：**文件 → 该文件被豁免的 id 集合**（`'*'` = 整文件豁免）。
//
// 为什么是「文件 + id」而不是整文件：整文件豁免会连带放过这个文件**将来**新写的
// 真·分派分支，等于把守卫在这个文件上永久关掉。按 id 登记则只放过已知的那一条，
// 别的 id 一出现照报。
//
// 什么算正当理由：只有「该字面量不是为了在运行机器上定位一个拓展」。
// 描述**仓库布局**（重建源码包时要复制哪个目录）与记述**历史**（bug 案例的文件清单）
// 都属此类——它们换成服务名既无意义也无从解析，因为那时根本没有一个在位的拓展可解析。
// 名单保持封闭：新增项须在此显式登记并写明理由。
const EXTENSION_ID_ALLOWLIST = new Map([
  // 契约自身的实现件：它必须能写出 id，否则契约模块过不了它自己的规则。
  ['services/backend/src/services/extensions/markdownWorkbench.js', '*'], // LEGACY_ID 迁移期兜底
  // pip 源码包重建：它按**仓库布局**逐目录复制（'docs'、'frontend'、'packages/shared' 同理），
  // 描述的是要重建出的那棵树长什么样，不是在这台机器上找一个已安装的拓展。
  ['services/backend/src/cli/handlers/publish.js', new Set(['khy-alpine-iso'])],
  // 历史 bug 案例数据集：files[] 记的是**当年那次事故**改了哪些文件，是史料不是分派。
  ['services/backend/src/data/bugCases.js', new Set(['khy-alpine-iso'])],
]);

/** 该文件的该 id 是否已登记豁免。 */
function _idAllowed(file, id) {
  const entry = EXTENSION_ID_ALLOWLIST.get(file);
  if (!entry) return false;
  return entry === '*' || entry.has(id);
}

/**
 * 把一份源码剥成「只剩会被执行的代码」的逐行数组。
 *
 * 剥掉两类**不算分支**的文本：
 *   ① 注释（行注释 + 跨行块注释）—— 注释记述历史、指路、写迁移说明，本来就该能提 id；
 *   ② 含中文的字符串字面量 —— 面向用户的提示文案。禁掉它只会逼人把
 *      「未找到 khy-markdown 拓展」写成「未找到拓展」，对架构毫无好处，只是让报错变模糊。
 *
 * 必须整文件扫而不是逐行扫：JSDoc 的续行长这样 `  * 底层复用 khy-markdown 拓展`，
 * 单看这一行没有任何注释标记，逐行剥离会把整个文档块当成代码 —— 那正是本规则
 * 第一版 6 个命中里 5 个是误报的原因。块注释状态必须跨行保持。
 *
 * @param {string} text 源码全文
 * @returns {string[]} 与原文行号一一对应的「代码残余」（被剥掉的部分留空串）
 */
function stripToCode(text) {
  const src = text.split(/\r?\n/);
  const out = new Array(src.length).fill("");
  let inBlock = false;
  for (let li = 0; li < src.length; li++) {
    const line = src[li];
    let acc = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const close = line.indexOf("*/", i);
        if (close === -1) { i = line.length; break; }
        inBlock = false;
        i = close + 2;
        continue;
      }
      const c = line[i];
      if (c === "/" && line[i + 1] === "/") break;          // 行注释 → 丢弃本行剩余
      if (c === "/" && line[i + 1] === "*") { inBlock = true; i += 2; continue; }
      if (c === "'" || c === "\"" || c === "`") {
        const quote = c;
        let j = i + 1;
        let body = "";
        while (j < line.length) {
          if (line[j] === "\\") { body += line[j + 1] || ""; j += 2; continue; }
          if (line[j] === quote) break;
          body += line[j];
          j += 1;
        }
        // 含中文 → 提示文案，抹掉；纯 ASCII → 可能是分派用的 id，保留。
        acc += /[\u4e00-\u9fa5]/.test(body) ? "" : quote + body + quote;
        i = j + 1;
        continue;
      }
      acc += c;
      i += 1;
    }
    out[li] = acc;
  }
  return out;
}

function checkExtensionIdHardcode(findings, counts) {
  const extRoot = path.join(repoRoot, 'extensions');
  if (!fs.existsSync(extRoot)) {
    counts['extension-id-hardcode'] = 0;
    return;
  }
  // 两层枚举（§2.3）：拓展可能在 extensions/<分类>/<id>。只看一层的话，一批拓展
  // 移进分类目录后这条守卫会静默变成空转 —— 「核里不许点名拓展 id」从此不再被检查。
  const ids = collectExtensionDirs(extRoot)
    .extensions
    // kind: ide-bridge 不纳入。它交付的是给外部 IDE 安装的 VSIX，宿主是 IDE 而不是
    // khy 进程（契约 §2.2：核**不激活**它）。核里写它的名字时，拼的是
    // `<IDE globalStorage>/<id>/` 这种由 **IDE 侧**规则决定的路径 —— 那不是
    // 「核为了找拓展而点名它」，而是读一个外部系统按它自己规则存的文件，
    // 改成服务名也无法影响它。强制这类 id 只会造出无法修复的违规。
    .filter(({ abs }) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(abs, EXTENSION_MANIFEST), 'utf8'));
        return !m || m.kind !== 'ide-bridge';
      } catch {
        return true; // 读不到 manifest → 保守地纳入（extension-contract 那条会先报它）
      }
    })
    .map(({ id }) => id);
  if (ids.length === 0) {
    counts['extension-id-hardcode'] = 0;
    return;
  }

  // 用目录 pathspec + 后缀过滤，而不是 `${d}/**/*.js`：git 的 pathspec 里 `**`
  // 不是递归通配，`src/**/*.js` 匹配不到直接放在 src/ 下的文件 —— 真实仓库
  // 因为核代码都在子目录里才碰巧有结果，夹具里一放到 src/ 根下就静默漏掉。
  const files = git(['ls-files', ...CORE_SCAN_DIRS])
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(f => f.endsWith('.js'))
    .filter(f => !f.includes('node_modules/'))
    .filter(f => EXTENSION_ID_ALLOWLIST.get(f) !== '*');

  const violations = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    // 快通道：整文不含任何 id 就不必逐行剥离。
    if (!ids.some(id => text.includes(id))) continue;
    const lines = stripToCode(text);
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i];
      for (const id of ids) {
        if (code.includes(id) && !_idAllowed(rel, id)) {
          violations.push(`${rel}:${i + 1} —— 硬编码拓展 id ${JSON.stringify(id)}`);
          break;
        }
      }
    }
  }

  counts['extension-id-hardcode'] = violations.length;
  if (violations.length === 0) return;
  findings.push({
    id: 'extension-id-hardcode',
    severity: 'warning',
    message: `${violations.length} 处核代码硬编码了拓展 id。`,
    detail:
      `${violations.slice(0, 3).join('；')}${violations.length > 3 ? ' …' : ''} —— ` +
      `改用服务名定位（manifest 的 provides + extensionRoots.findProvider），契约见 ` +
      `docs/03_DESIGN_设计/[DESIGN-ARCH-069] 拓展契约与核心边界规范.md §1.3；` +
      `全量清单用 --list=extension-id-hardcode。`,
    full: violations,
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

// ── 拓展路径漂移（[DESIGN-ARCH-069] §4.1 的机器化）─────────────────────────
// 为什么单列一条而不是靠 unresolved-require：那条只看 `../../` 起步的深层 require，
// 于是漏掉两类「搬目录搬坏了」的典型：
//   ① 单层 `../lib/x` —— 拓展从 scripts/<子目录>/ 挪到 extensions/scripts/<id>/ 后，
//      同一个 `../lib` 指向的已经不是同一个地方了；
//   ② `path.resolve(__dirname, '..', '..')` 这类爬根算术 —— 它**不会**在加载期抛错，
//      只会静默算出一个错的根，然后在运行时表现为「什么都没探测到」。②比①危险得多。
// 只查 extensions/：拓展是会被整体搬动的那类目录，深度敏感的代码在这里最脆。
function collectExtensionSources() {
  const out = [];
  const root = path.join(repoRoot, 'extensions');
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === '.git') continue;
        walk(abs);
      } else if (/\.[cm]?js$/.test(entry.name)) {
        out.push(abs);
      }
    }
  };
  walk(root);
  return out;
}

// 从任意目录往上找到它所属拓展的根（带 khy.extension.json 的那一层）。
// 找不到就返回 null —— extensions/ 下也存在还没上契约的目录，那由 extension-contract 管。
function extensionRootOf(dir) {
  const stop = path.join(repoRoot, 'extensions');
  let cur = dir;
  while (cur.startsWith(stop) && cur !== stop) {
    if (fs.existsSync(path.join(cur, 'khy.extension.json'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

function checkExtensionPathDrift(findings, counts) {
  const RELATIVE_REQUIRE = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  // 只接全字面量参数：出现变量就判不了，交给人。
  // 不认死 `path.` 这个接收者：`require('path').resolve(...)`、`nodePath.join(...)` 一样要认。
  // 第一个实参就是 __dirname 已经是足够强的特征，再要求接收者叫 path 只会漏。
  const DIRNAME_JOIN = /\.(?:join|resolve)\(\s*__dirname\s*,([^)]*)\)/g;
  const LITERAL = /^\s*(['"])(.*?)\1\s*$/;
  const broken = [];

  for (const abs of collectExtensionSources()) {
    const rel = toPosix(path.relative(repoRoot, abs));
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    const dir = path.dirname(abs);
    const lineOf = (index) => src.slice(0, index).split('\n').length;
    const lineTextOf = (index) => src.slice(src.lastIndexOf('\n', index) + 1, src.indexOf('\n', index) + 1 || undefined);

    RELATIVE_REQUIRE.lastIndex = 0;
    for (let m = RELATIVE_REQUIRE.exec(src); m; m = RELATIVE_REQUIRE.exec(src)) {
      const lineText = lineTextOf(m.index);
      if (looksLikeComment(lineText, lineText.indexOf('require('))) continue;
      const target = path.resolve(dir, m[1]);
      if (!resolvesOnDisk(toPosix(path.relative(repoRoot, target)))) {
        broken.push(`${rel}:${lineOf(m.index)} → require('${m[1]}')（不存在）`);
      }
    }

    DIRNAME_JOIN.lastIndex = 0;
    for (let m = DIRNAME_JOIN.exec(src); m; m = DIRNAME_JOIN.exec(src)) {
      const pieces = m[1].split(',').map(x => x.trim()).filter(Boolean);
      const parts = [];
      let allLiteral = pieces.length > 0;
      for (const piece of pieces) {
        const lm = piece.match(LITERAL);
        if (!lm) { allLiteral = false; break; }
        parts.push(...lm[2].split('/').filter(Boolean));
      }
      // 只查「往上爬」的：不以 .. 开头的是脚本自己旁边的路径（如运行时自建的输出
      // 目录），与所在深度无关，天然不会因为搬家而漂。
      if (!allLiteral || parts[0] !== '..') continue;
      const lineText = lineTextOf(m.index);
      if (looksLikeComment(lineText, 0)) continue;
      const target = path.resolve(dir, ...parts);

      if (parts.every(part => part === '..')) {
        // 纯 `..` 序列 = 拿某个祖先目录当基准。在拓展里只有两个落点说得通：
        // **仓库根**（要读仓库里的东西）或**本拓展内部**（含自己的根，如 test/ 往上一层）。
        // 落在两者之间的 extensions/ 或 extensions/<分类>/ 上没有任何意义 —— 那是布局
        // 的中间层，不是谁的根 —— 而这恰恰是拓展被搬深一层后必然出现的症状。
        // 这一条不能靠「路径存不存在」来判：那些中间目录**都存在**，正是它让这类漂移
        // 完全无声（不抛错、不报缺失，只是从此什么都探测不到）。所以直接钉死落点。
        const extRoot = extensionRootOf(dir);
        const inExt = extRoot && (target === extRoot || target.startsWith(extRoot + path.sep));
        if (path.resolve(target) !== path.resolve(repoRoot) && !inExt) {
          broken.push(`${rel}:${lineOf(m.index)} → __dirname/${parts.join('/')} `
            + `落在 ${toPosix(path.relative(repoRoot, target)) || '.'}，`
            + '既不是仓库根也不在本拓展内（爬根层数算错）');
        }
        continue;
      }

      // 带具体段的：有的当 require 说明符用（无扩展名），所以要试模块后缀；
      // 这里问的是「存不存在」，不是「node 能不能 require」——用 existsSync 而不是
      // resolvesOnDisk，后者会因为目录里没有 index.js 就把一个真实存在的目录判为不存在。
      const hit = ['', '.js', '.cjs', '.mjs', '.json'].some(ext => fs.existsSync(target + ext));
      if (!hit) {
        broken.push(`${rel}:${lineOf(m.index)} → __dirname/${parts.join('/')}（不存在）`);
      }
    }
  }

  counts['extension-path-drift'] = broken.length;
  if (broken.length > 0) {
    findings.push({
      id: 'extension-path-drift',
      severity: 'warning',
      message: `${broken.length} 处拓展内的相对路径指向磁盘上不存在的位置（搬目录时级数算错）。`,
      detail: '相对 require 会在加载期抛 MODULE_NOT_FOUND；__dirname 爬根算术不抛错，'
        + `只会静默算错根、到运行时才表现为「什么都没找到」。首例：${broken.slice(0, 4).join(' | ')}`,
      full: broken,
    });
  }
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
  checkExtensionContract(findings, counts);
  checkExtensionIdHardcode(findings, counts);
  checkExtensionPathDrift(findings, counts);

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
