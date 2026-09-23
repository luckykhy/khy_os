#!/usr/bin/env node
/**
 * check-agent-docs.js — AI 指令文件标准守卫（规则 DOCS-003 原型）
 *
 * 背景（实测，非推测）
 * -------------------
 * 仓库根与子目录里散布着多份「AI 指令文件」（AGENTS.md / CLAUDE.md / khy.md /
 * .windsurfrules / .github/copilot-instructions.md …）。它们的作者默认「写进去就会被
 * AI 读到」，但运行时的读取方 `instructionFileService.js` 有**分层字符预算**，超限
 * **静默截断**（`readFileSafe` 只 slice，不报错）：
 *
 *   tier=own     khy.md / KHY.md            MAX_FILE_CHARS    = 8000 / 文件
 *   tier=compat  CLAUDE.md / AGENTS.md …    MAX_FILE_CHARS    = 8000 / 文件
 *   tier=eco     .windsurfrules / copilot…  ECO_MAX_FILE_CHARS= 4000 / 文件
 *   合并总预算                              MAX_TOTAL_CHARS   = 24000
 *   eco 层总预算                            ECO_MAX_TOTAL_CHARS = 8000
 *
 * 后果：`AGENTS.md` 的「工程规则（强制）」节（RUNTIME-001~004 的语义真源）位于
 * 第 265 行之后，而 8000 字符截断点落在第 226 行 —— **AI 被要求遵守一份它读不到的规则**。
 *
 * 本脚本把这些「写了但到不了」的静默失效变成可判定的 finding。
 *
 * 纪律（与仓库既有守卫一致）
 * -------------------------
 *   - 零外部依赖（只用 fs / path / child_process）
 *   - 确定性、可离线跑、**只读不改业务**
 *   - 常量从源码读取（不硬编码预算），清单从既有注册表派生（不另立真源）
 *   - 判定只看客观证据（文件字节、源码常量、CLI 真源），不接受 AI 自称
 *
 * 输出契约（必须遵守，否则 ruleguard 的棘轮与抑制都失效）
 * ------------------------------------------------------
 *   stdout 只放 finding，格式为仓库统一约定（`scripts/ruleguard/lib/run.js` 的
 *   `FINDING_LINE`），第二行起两个空格缩进写正文：
 *     [ERROR] <finding-id> <相对路径>:<行号>
 *       <人类可读说明>
 *   诊断信息（表头 / 预算 / --verbose 表格）一律走 **stderr** —— 否则缩进行会被
 *   解析器当成上一条 finding 的 message 正文。
 *   `file` 必须是**单个路径且不含空格**（`\S+`），多文件问题要拆成多条 finding。
 *   行号必须是**真实行**：ruleguard 的 `khy-allow-DOCS-003` 是行锚定的，
 *   0 号行永远匹配不上，等于把 finding 变成不可豁免。
 *
 * Usage
 * -----
 *   node scripts/ci/check-agent-docs.js                # 扫描全仓
 *   node scripts/ci/check-agent-docs.js --json         # 机器可读
 *   node scripts/ci/check-agent-docs.js --files=AGENTS.md,CLAUDE.md
 *   node scripts/ci/check-agent-docs.js --scenario=budget-overflow   # 反例矩阵
 *   node scripts/ci/check-agent-docs.js --list-scenarios
 *   node scripts/ci/check-agent-docs.js --verbose
 *
 * Exit: 0 clean, 1 findings, 2 usage error（与 scripts/ci/ 其余检查器同契约）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RULE_ID = 'DOCS-003';
const REGISTRY_REL = path.join('docs', '10_规范', 'registry', 'RULES-REGISTRY.json');
const LAYOUT_REL = path.join('scripts', 'ci', 'check-repo-layout.js');
const IFS_REL = path.join('services', 'backend', 'src', 'services', 'instructionFileService.js');
const ECO_REL = path.join('services', 'backend', 'src', 'services', 'instructionEcosystemRegistry.js');
/** compat 层（`CLAUDE.md`/`AGENTS.md`）的真实读取方 —— 它**没有**字符预算。 */
const PROMPTS_REL = path.join('services', 'backend', 'src', 'constants', 'prompts.js');

// 扫描时跳过的目录：构建产物 / 依赖 / 本机缓存 / 外部调研克隆
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.khyos', '.research-tmp', 'dist', 'dist-electron',
  'build', 'coverage', '__pycache__', '.venv', 'venv',
]);

// ── 仓库定位（可重定位：脚本从 _产物/ 移到 scripts/ci/ 后无需改路径）──────────
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (
      fs.existsSync(path.join(dir, REGISTRY_REL)) &&
      fs.existsSync(path.join(dir, 'package.json'))
    ) {
      return dir;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const repoRoot = process.env.KHY_AGENT_DOCS_ROOT
  ? path.resolve(process.env.KHY_AGENT_DOCS_ROOT)
  : findRepoRoot(__dirname);

if (!repoRoot) {
  console.error('无法定位仓库根（未找到 RULES-REGISTRY.json + package.json）。');
  process.exit(2);
}

// ── 常量真源：全部从源码读，不硬编码 ────────────────────────────────────────
function readBudgets() {
  const read = (rel) => {
    const abs = path.join(repoRoot, rel);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  };
  const ifs = read(IFS_REL);
  const eco = read(ECO_REL);
  const pick = (text, re, fallback) => {
    const m = String(text).match(re);
    return m ? Number(m[1]) : fallback;
  };
  return {
    own: {
      perFile: pick(ifs, /MAX_FILE_CHARS\s*=\s*(\d+)/, 8000),
      total: pick(ifs, /MAX_TOTAL_CHARS\s*=\s*(\d+)/, 24000),
    },
    eco: {
      perFile: pick(eco, /ECO_MAX_FILE_CHARS\s*=\s*(\d+)/, 4000),
      total: pick(eco, /ECO_MAX_TOTAL_CHARS\s*=\s*(\d+)/, 8000),
    },
  };
}

/** 从 instructionFileService 读 FILENAMES / COMPAT_FILENAMES，从生态注册表读 project 级来源。 */
function readFilenameTruth() {
  const abs = path.join(repoRoot, IFS_REL);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const arr = (name, fallback) => {
    const m = text.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
    if (!m) return fallback;
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  };
  const own = arr('FILENAMES', ['khy.md', 'KHY.md']);
  const compat = arr('COMPAT_FILENAMES', ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']);

  // 生态来源：registry 是零 IO 叶子，直接 require 拿声明式清单（不另立真源）。
  // 注意描述符**不含 `segs` 字段** —— 只有 `path`（绝对路径）。早先按 `segs` 派生会
  // 静默得到空数组并退回硬编码兜底，导致 `.github/copilot-instructions.md` 漏扫。
  let ecoRel = [];
  try {
    const reg = require(path.join(repoRoot, ECO_REL));
    const sources = reg.instructionEcosystemSources({
      homedir: path.join(repoRoot, '.nonexistent-home'),
      projectDir: repoRoot,
      env: {},
    });
    for (const src of sources) {
      if (!src || src.mode !== 'file' || !src.path) continue;
      const rel = path.relative(repoRoot, src.path);
      ecoRel.push(rel.startsWith('..') ? path.basename(src.path) : rel.split(path.sep).join('/'));
    }
  } catch (error) {
    ecoRel = ['.windsurfrules', '.github/copilot-instructions.md', '.cursorrules', 'GEMINI.md'];
  }
  return { own, compat, eco: ecoRel };
}

/** 根目录说明性文件白名单（真源 check-repo-layout.js 的 ROOT_DOC_WHITELIST）。 */
function readRootWhitelist() {
  const abs = path.join(repoRoot, LAYOUT_REL);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const m = text.match(/ROOT_DOC_WHITELIST\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return new Set(['AGENTS.md', 'CLAUDE.md', 'khy.md']);
  return new Set(
    m[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s && !s.startsWith('//')),
  );
}

/** 根目录「说明性文件」的扩展名闸（真源 check-repo-layout.js 的 `ROOT_DOC_EXT_RE`）。
 *
 *  为什么 D6 的**根级分支**必须复用这道闸：D6 引用的真源是 `[MGMT-STD-001]` §1.3，
 *  而 §1.3 的管辖范围**显式限于 `.md`/`.txt`**（原文：「白名单之外的任何说明性
 *  `.md`/`.txt`，一律适用第 1.1、1.2 条」）。
 *  `.windsurfrules` / `.clinerules` / `.cursorrules` 这类**无扩展名的生态层指令文件**
 *  由 `khy metadata link` 生成、并已在 `instructionEcosystemRegistry.js` 声明
 *  （`{ key: 'windsurf', file: '.windsurfrules', mode: 'inject' }`），本就不在 §1.3 辖区内。
 *  不设这道闸 = 引 A 条款去判 B 范围外的对象 = 纯误报
 *  （公理 A4：误报的守卫会被整体绕过，比没有更糟）。
 *
 *  注意这**只**收窄根级分支；`_产物/` 分支不受影响 —— 那里的问题与扩展名无关。 */
function readRootDocExt() {
  const abs = path.join(repoRoot, LAYOUT_REL);
  const text = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const m = text.match(/ROOT_DOC_EXT_RE\s*=\s*\/(.+?)\/([a-z]*)/);
  if (!m) return /\.(?:md|txt)$/i;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return /\.(?:md|txt)$/i;
  }
}

// ── CLI 真源（命令可达性判据）──────────────────────────────────────────────
//
// 两个陷阱（都踩过，留证）：
//   1. `metadata` 不在 aliases.js 里，却真实可达 —— 它由 commandAutoRegistry
//      扫描 cli/handlers/*.js 的**命令清单导出**自注册（router.js:229 init()、
//      :980 dispatch）。只查别名表会误报。
//   2. 反过来，「handlers/ 下有同名文件」**不等于**可达 —— 只有导出了清单
//      （`__khyCommandManifest` / `commandManifest`）才会被注册。所以判据必须取
//      registry 的实际注册结果，不能拿文件名猜。
function readCliTruth() {
  const names = new Set();
  try {
    const aliases = require(path.join(repoRoot, 'services/backend/src/cli/aliases.js'));
    const walk = (node) => {
      for (const key of Object.keys(node || {})) {
        const value = node[key];
        if (typeof value === 'string') {
          names.add(key);
          names.add(value);
        } else if (value && typeof value === 'object') {
          walk(value);
        }
      }
    };
    walk(aliases);
  } catch (error) {
    /* 别名表不可读时退化为只用注册表结果 */
  }
  try {
    if (!process.env.KHYQUANT_CWD) process.env.KHYQUANT_CWD = repoRoot;
    const registry = require(path.join(repoRoot, 'services/backend/src/cli/commandAutoRegistry.js'));
    registry.init();
    for (const name of registry.getCommandNames()) names.add(String(name).toLowerCase());
  } catch (error) {
    /* 注册表不可用时保守放行，宁漏报不误报 */
  }
  return names;
}

function readNpmScripts() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return new Set(Object.keys(pkg.scripts || {}));
  } catch (error) {
    return new Set();
  }
}

/** 根 package.json 的 workspaces 声明 —— `--workspace <id>` 的合法性真源。 */
function readWorkspaces() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const list = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces && pkg.workspaces.packages) || [];
    return new Set(list.map(String));
  } catch (error) {
    return new Set();
  }
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, REGISTRY_REL), 'utf8'));
    const byId = new Map();
    for (const rule of data.rules || []) byId.set(rule.id, rule);
    return byId;
  } catch (error) {
    return new Map();
  }
}

// ── 可达性判据所需的索引（一次建好，避免逐行 IO）──────────────────────────
const _pkgScriptsCache = new Map();

/** 读取某个包目录的 scripts；目录不存在时返回空集。 */
function scriptsOfPackage(relDir) {
  const dir = path.resolve(repoRoot, relDir);
  if (_pkgScriptsCache.has(dir)) return _pkgScriptsCache.get(dir);
  let scripts = new Set();
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      scripts = new Set(Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts || {}));
    }
  } catch (error) {
    scripts = new Set();
  }
  _pkgScriptsCache.set(dir, scripts);
  return scripts;
}

/** 从指令文件所在目录向上找最近的 package.json —— npm 的真实解析语义。 */
function nearestPackageScripts(relFile) {
  let dir = path.dirname(path.join(repoRoot, relFile));
  for (;;) {
    const rel = path.relative(repoRoot, dir);
    const scripts = scriptsOfPackage(rel);
    if (scripts.size) return scripts;
    if (rel === '' || rel === '.' || dir === repoRoot) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return scriptsOfPackage('');
}

/** 仓库索引：顶层目录、全仓 basename、docs/ 下的文档编号。 */
function buildRepoIndex() {
  const all = [];
  walk(repoRoot, all, 0);
  const topDirs = new Set();
  const basenames = new Set();
  for (const abs of all) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    topDirs.add(rel.split('/')[0]);
    basenames.add(path.basename(rel));
  }
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) topDirs.add(entry.name);
  }
  // 文档编号真源：**全仓**文件名里的 [XXX-NNN]。
  // 踩过的坑：只扫根 docs/ 会把 apps/khyos-desktop/docs/[DESIGN-ARCH-092] 判成
  // 「不存在」—— 子项目有自己的 docs/ 目录，索引必须覆盖全仓。
  const docIds = new Set();
  for (const abs of all) {
    for (const m of path.basename(abs).matchAll(/\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3})\]/g)) {
      docIds.add(m[1]);
    }
  }
  return { topDirs, basenames, docIds };
}

// ── 文件发现 ────────────────────────────────────────────────────────────────
function walk(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out, depth + 1);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/** 把绝对路径归类到 tier；返回 null 表示不是 AI 指令文件。 */
function classify(relPath, truth) {
  const normalized = relPath.split(path.sep).join('/');
  const base = path.basename(normalized);
  const ownSet = new Set(truth.own);
  const compatSet = new Set(truth.compat.map((p) => p.split('/').pop()));
  const ecoRel = new Set(truth.eco);
  const ecoBase = new Set(truth.eco.map((p) => p.split('/').pop()));

  // 目录型生态来源（.cursor/rules/*.mdc、.kiro/steering/* 等）
  if (/^\.(cursor|windsurf|clinerules|roo|kiro|amazonq|continue)\//.test(normalized)) return 'eco';
  if (/^\.github\/(?:instructions|prompts)\//.test(normalized)) return 'eco';
  if (/^\.trae\/rules\//.test(normalized)) return 'eco';

  if (ownSet.has(base)) return 'own';
  if (compatSet.has(base)) return 'compat';
  if (ecoRel.has(normalized) || ecoBase.has(base)) return 'eco';
  if (/^(GEMINI|QWEN|CONVENTIONS)\.md$/.test(base)) return 'eco';
  if (base === '.cursorrules' || base === '.windsurfrules' || base === '.rules') return 'eco';
  return null;
}

function collectTargets(truth, explicit) {
  const all = [];
  walk(repoRoot, all, 0);
  const targets = [];
  for (const abs of all) {
    const rel = path.relative(repoRoot, abs);
    const tier = classify(rel, truth);
    if (tier) targets.push({ rel: rel.split(path.sep).join('/'), abs, tier });
  }
  targets.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  if (explicit && explicit.length) {
    const want = new Set(explicit.map((s) => s.split(path.sep).join('/')));
    return targets.filter((t) => want.has(t.rel));
  }
  return targets;
}

// ── 检查实现（全部纯函数：输入文本 + 上下文，输出 finding）──────────────────
//
// finding 的定位必须是**真实行号**，不能用 0 占位：
//   - ruleguard 的 `khy-allow-<RULE-ID>` 抑制是行锚定的（`suppression.js` 只认
//     `entry.line === line || entry.line + 1 === line`），line=0 永远匹配不上，
//     等于把该 finding 变成不可豁免。
//   - 文件级问题也有它的「真实行」：预算超限报**耗尽那一行**，重复块报**首次出现的行**。
const findings = [];
function add(severity, file, check, message, line = 1) {
  const normalized = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;
  findings.push({ rule: RULE_ID, severity, check, file, line: normalized, message });
}

/** 字符偏移 → 1-based 行号。用于把「第 N 个字符超预算」翻译成可定位的行。 */
function lineAtCharOffset(text, offset) {
  const capped = Math.max(0, Math.min(offset, text.length));
  return text.slice(0, capped).split(/\r?\n/).length;
}

/** D1 预算闸 —— 写了但到不了，是最高频的静默失效。
 *
 *  ⚠️ **适用范围曾经写错，留证以免复发**：本检查只对 **own 与 eco** 两档生效，
 *  **compat（`CLAUDE.md`/`AGENTS.md`）不设预算**。理由（全部可复核）：
 *   - `instructionFileService.js` 的 `MAX_FILE_CHARS` / `MAX_TOTAL_CHARS` 只作用于
 *     `loadInstructions()` 装配的 own 层（`khy.md`/`KHY.md` + `.khy/rules/*.md` + `@include` 目标）。
 *   - compat 层由 **`constants/prompts.js` 的 `_findCompatInstructionFiles()`** 加载
 *     （`fs.readFileSync(...).trim()`，**无 slice**），再由 `getProjectInstructionsSection()`
 *     整体 push 进 `project_instructions` 提示词段 —— 全量注入，不截断。
 *   - 生态注册表 `instructionEcosystemRegistry.js` 也明写「Project-level AGENTS.md is
 *     already handled by prompts.js compatibility discovery」，刻意不把 compat 重复收进 eco 预算。
 *   - 实测（2026-09-16）：`getProjectInstructionsSection(cwd)` 返回 33823 字符，
 *     其中包含 `AGENTS.md` 全文 22668 字符与 `CLAUDE.md` 全文 —— `includes()` 全部命中。
 *
 *  ⇒ 给 compat 套 own 的 8000 预算 = 引 A 条款判 B 范围外的对象 = 纯误报
 *    （曾据此报出「AGENTS.md 只见 35.3%」，实测为假）。公理 A5：常量从源码读，
 *    不得为「看起来该有预算」而自造阈值。
 *
 *  定位到**预算耗尽的那一行**：这既是真实行（可被 khy-allow 锚定），
 *  也是最有信息量的答案 —— 作者一眼就知道该从哪儿开始砍。 */
function checkBudget(file, text, budgets, severityCap) {
  const tier = file.tier;
  if (tier === 'compat') return; // 无读取预算：prompts.js 全量注入，见上
  const limit = tier === 'eco' ? budgets.eco.perFile : budgets.own.perFile;
  const n = text.length;
  if (n <= limit) return;
  const visible = ((limit / n) * 100).toFixed(1);
  add(
    severityCap,
    file.rel,
    'D1-budget',
    `字符数 ${n} 超出 tier=${tier} 的读取预算 ${limit}（可见 ${visible}%，` +
      `静默丢失 ${n - limit} 字符，预算从此行起失效）。预算真源：${tier === 'eco' ? ECO_REL : IFS_REL}`,
    lineAtCharOffset(text, limit),
  );
}

/** D2 优先级自封闸 —— 非根指令文件不得自行宣布覆盖别的文件。
 *
 *  判据（曾写错，留证以免复发）：**不能**拿「某条规则的 paths 覆盖了该文件」当豁免 ——
 *  `services/**` 这类通配会一次性豁免整个 services 树，闸门形同虚设。
 *  豁免只认**字面登记**：某条规则的 paths 里出现该文件的完整相对路径（不含 `*`）。
 */
const RE_PRECEDENCE_G = /(以本文件为准|优先于|覆盖(?:根目录|上级)?\s*`?AGENTS\.md|优先(?:级)?(?:高于|大于))/g;
/** 「优先于」的**宾语**必须指向指令文件，否则「新增文件优先于修改现有文件」这类
 *  普通编码指引会被判成「自封优先级」—— 实测命中（`tui/AGENTS.md:27`），属误报。
 *  公理 A4：误报的守卫会被整体绕过，比没有更糟。 */
const RE_PRECEDENCE_TARGET = /(AGENTS|CLAUDE|KHY)\.md|根目录|上级|根级|指令文件/i;
function checkPrecedence(file, text, registry) {
  if (!file.rel.includes('/')) return; // 根章程自己定义优先级是合法的
  const literallyRegistered = [...registry.values()].some(
    (r) =>
      Array.isArray(r.paths) &&
      r.paths.some((p) => !String(p).includes('*') && String(p) === file.rel),
  );
  if (literallyRegistered) return;
  for (const m of text.matchAll(RE_PRECEDENCE_G)) {
    if (m[1] === '优先于') {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const lineEnd = text.indexOf('\n', m.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      if (!RE_PRECEDENCE_TARGET.test(line)) continue;
    }
    add(
      'warning',
      file.rel,
      'D2-precedence',
      `就地自封优先级（命中「${m[1]}」），但没有任何规则以字面路径登记本文件的优先级。` +
        `就地声明会静默推翻上层章程；运行时的真实优先级由 instructionEcosystemRegistry 决定` +
        `（khy 自身文件 > 生态层），文档声明与它不一致时必须先登记再声明。`,
      lineAtCharOffset(text, m.index),
    );
    return; // 一个文件报一条足够，避免刷屏
  }
}

/** 示例块识别 —— 示意性的命令/路径不是可执行契约，判进去就是误报。
 *
 *  两个判据（都来自实证误报，不是猜的）：
 *    1. 语境：紧邻标题/引言含「示例/example/样例/映射/示意/输出」。
 *    2. 内容：块内含 ❌/✅ 对比标记 —— 这是**输出文案对照**，里面的命令是
 *       被展示的字符串，不是让人去执行的（AGENTS.md 规则 2.3 的 ❌/✅ 块里
 *       出现 `npm run build`，而根 package.json 根本没有 build 脚本）。
 */
const RE_ILLUSTRATIVE = /示例|样例|示意|举例|example|e\.g\.|输出映射|文案映射|演示/;
const RE_CONTRAST = /[❌✅]/;

/** 预计算每个行号是否落在「示意性代码块」内。 */
function illustrativeLines(lines) {
  const flags = new Array(lines.length).fill(false);
  let openAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*```/.test(lines[i])) continue;
    if (openAt < 0) {
      openAt = i;
      continue;
    }
    // 闭合围栏：判定该块的语境
    let illustrative = lines.slice(openAt + 1, i).some((l) => RE_CONTRAST.test(l));
    if (!illustrative) {
      for (let j = openAt - 1; j >= Math.max(0, openAt - 6); j -= 1) {
        if (/^\s*```/.test(lines[j])) break;
        if (RE_ILLUSTRATIVE.test(lines[j])) {
          illustrative = true;
          break;
        }
      }
    }
    if (illustrative) {
      for (let j = openAt; j <= i; j += 1) flags[j] = true;
    }
    openAt = -1;
  }
  return flags;
}

/** 占位符路径 —— 文档里的「自己填」示例，不是真指针。 */
const RE_PLACEHOLDER = /(your|xxx|example|placeholder|foo|bar|baz|my[A-Z]|\.\.\.|…|NNN)/;

/** D3 死指针闸 —— 文档里的路径 / 命令 / 规则 ID 必须真实可达。 */
function checkDeadPointers(file, text, ctx) {
  const lines = text.split(/\r?\n/);
  const illustrative = illustrativeLines(lines);
  const seen = new Set();
  const localScripts = nearestPackageScripts(file.rel);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(?:>|\||-{3,})/.test(line)) continue; // 引用块/表格分隔线不判

    // D3a `npm run [--flags] <script>` —— 脚本解析范围随 `--workspace` 或就近
    // package.json 变化。踩过三个坑：
    //   1. `npm run dev` 写在 apps/khyos-desktop/CLAUDE.md 里指的是**子包**脚本，
    //      只查根 package.json 会把它们全判死 → 改为就近 package.json。
    //   2. 参数可出现在脚本名**之前**（`npm run --workspace backend test:tui`），
    //      旧正则把 `--workspace` 当成了脚本名。
    //   3. `--workspace <id>` 的 id 必须真的在根 package.json 的 workspaces 里
    //      （`backend` 既不是路径 services/backend 也不是包名 khy-os-backend → npm 报错）。
    for (const m of line.matchAll(/npm run\s+((?:(?:--?[\w-]+(?:[= ]\S+)?)\s+)*)([a-zA-Z0-9:_-]+)([^\n`]*)/g)) {
      if (illustrative[i]) continue;
      const preFlags = m[1] || '';
      const script = m[2];
      const tail = `${preFlags} ${m[3] || ''}`;
      const wsMatch = tail.match(/--workspace[= ]([A-Za-z0-9_./@-]+)|(?:^|\s)-w[= ]([A-Za-z0-9_./@-]+)/);
      const wsId = wsMatch ? wsMatch[1] || wsMatch[2] : null;
      const key = `npm:${wsId || ''}:${script}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (wsId) {
        if (!ctx.workspaces.has(wsId)) {
          add(
            'error',
            file.rel,
            'D3a-npm-script',
            `第 ${i + 1} 行的 \`--workspace ${wsId}\` 不是有效 workspace —— 根 package.json 的 ` +
              `workspaces 只有 ${[...ctx.workspaces].join('、')}（npm 会直接报 No workspaces found）。`,
            i + 1,
          );
          continue;
        }
        if (scriptsOfPackage(wsId).has(script)) continue;
        add(
          'error',
          file.rel,
          'D3a-npm-script',
          `第 ${i + 1} 行引用不存在的 npm 脚本「npm run ${script}」（workspace ${wsId}）。`,
          i + 1,
        );
        continue;
      }

      if (localScripts.has(script)) continue;
      add(
        'error',
        file.rel,
        'D3a-npm-script',
        `第 ${i + 1} 行引用不存在的 npm 脚本「npm run ${script}」（查找范围：就近 package.json）。`,
        i + 1,
      );
    }

    // D3b `khy <subcommand>`
    for (const m of line.matchAll(/`khy ([a-z][a-z0-9-]*)/g)) {
      const sub = m[1];
      if (sub === 'os' || ctx.cliNames.has(sub)) continue;
      const key = `khy:${sub}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(
        'warning',
        file.rel,
        'D3b-cli-command',
        `第 ${i + 1} 行引用 CLI 命令「khy ${sub}」，在别名表与 commandAutoRegistry 注册结果中均不可达（通道可能已移除）。`,
        i + 1,
      );
    }

    // D3c 规则/文档 ID [XXX-NNN] —— 必须「已登记为规则」或「存在同名文档」。
    // 踩过的坑：把 [DESIGN-GOV-001] 判成「未登记规则 ID」是错的 —— 它是**文档编号**，
    // 不是规则；两者共用 [域-NNN] 外形，判据必须查两处真源。
    for (const m of line.matchAll(/\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3})\]/g)) {
      const id = m[1];
      if (ctx.registry.has(id) || ctx.docIds.has(id)) continue;
      const key = `id:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(
        'warning',
        file.rel,
        'D3c-rule-id',
        `第 ${i + 1} 行引用「[${id}]」—— 既不在 RULES-REGISTRY.json 登记，全仓也没有同名文档。`,
        i + 1,
      );
    }

    // D3d 反引号内的仓库相对路径
    for (const m of line.matchAll(/`([A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]+\.(?:js|ts|mjs|cjs|md|json|yaml|yml|vue|py|html|mdc))`/g)) {
      const candidate = m[1];
      if (candidate.startsWith('~') || candidate.includes('<') || candidate.includes('*')) continue;
      if (RE_PLACEHOLDER.test(candidate)) continue; // `handlers/yourCmd.js` 是填空模板
      // 只认**根锚定**路径：首段必须是真实顶层目录。这条把
      // `ink-components/Viewport.js`（文件内相对简写）这类歧义写法排除在外。
      const head = candidate.split('/')[0];
      if (!ctx.topDirs.has(head)) continue;
      if (candidate.startsWith('.ai/')) continue; // 生成物，按需存在
      if (candidate.startsWith('.khy/')) continue;
      if (fs.existsSync(path.join(repoRoot, candidate))) continue;
      // 容忍简写：basename 在仓库里唯一存在即视为可达（如 `constants/serviceDefaults.js`）
      if (ctx.basenames.has(path.basename(candidate))) continue;
      const key = `path:${candidate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add('warning', file.rel, 'D3d-path', `第 ${i + 1} 行引用不存在的路径「${candidate}」。`, i + 1);
    }
  }
}

/** D4 标记行闸 —— 承担规则真源职责的文件必须双向可达（补 TOOLING-007 的缺口）。 */
function checkMarker(file, text, registry) {
  const markerIds = new Set();
  for (const m of text.matchAll(/RULES-REGISTRY:\s*([^\n]*?)(?:-->)?\s*$/gm)) {
    for (const hit of m[1].match(/[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}/g) || []) markerIds.add(hit);
  }
  // 正文里作为「真源」声明的规则 ID：表格中「真源」列 + 显式 ssot 句式
  const claimed = new Set();
  for (const m of text.matchAll(/\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3})\]/g)) {
    if (registry.has(m[1])) claimed.add(m[1]);
  }
  const missing = [...claimed].filter((id) => !markerIds.has(id));
  if (missing.length && markerIds.size === 0) {
    // 定位到**首次引用已登记规则 ID 的那一行** —— 那里就是「本该有标记行」的证据点。
    const hit = text.match(/\[[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3}\]/);
    add(
      'warning',
      file.rel,
      'D4-marker',
      `正文引用了已登记规则 ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' 等' : ''}，` +
        `但文件缺少 \`<!-- RULES-REGISTRY: ... -->\` 标记行 —— 该文件对 TOOLING-007 的双向可达检查不可见。`,
      hit ? lineAtCharOffset(text, hit.index) : 1,
    );
  }
}

/** D9 孪生面闸 —— 指令文件的 `.html` 孪生面改动必须与 `.md` 面同行。
 *
 *  **这条检查的来历（HQ 丢弃后的替代）**：指挥部仓库 `khy-os-hq` 的 `drivability` 检查
 *  强制「`CLAUDE.md` 与 `AGENTS.md` 必须同步修改」。HQ 被 khy-os 吸收后，这条机械保障
 *  在 khy-os 侧**没有等价守卫** —— 见 `[DESIGN-ARCH-118]` §四「诚实代价」。
 *  若不管，双入口就会静默漂移：改了 `.md` 忘了 `.html`（或反之），
 *  读者看到的两面说法不一致，而任何现有守卫都不会报。
 *
 *  **判据（谁必须声明）**：只查**显式声明了自己是「同步对」的文件** ——
 *  正文里有 `<!-- MIRROR: <孪生文件名> -->`。不声明则不报（默认放行），
 *  理由见公理 A4「误报比漏报更贵」：khy-os 全仓 700+ 个 `.html` 孪生件里，
 *  绝大多数是文档构建产物，把「凡 `.md` 都要有 `.html`」做成硬拦会淹掉真正的漂移。
 *
 *  **方向选择（刻意的）**：只查「声明了孪生面 → 孪生面必须存在且内容同源」，
 *  **不**查「`CLAUDE.md` 改了但 `AGENTS.md` 没改」这类**提交时序**判定 ——
 *  那需要读 git 历史，会让检查器依赖工作区状态（违反「确定性、可离线跑」纪律），
 *  且「同一次提交」在 rebase/合并后会失真。时序纪律留给 `PROCESS-005` 的人工评审，
 *  这里只做**可离线判定**的那一半：孪生面是否真的存在、是否真是同一批内容。
 *
 *  **为什么是 warning 而非 error**：孪生件由 `build_docs_site.js` 批量重写
 *  （历史 232 个 `.html` 被改过资源引用），存在真实的不同步窗口。
 *  定 error 会让每个开发者在构建产物抖动时被误伤。
 *
 *  @param {Map<string,string>|null} virtualFiles
 *    `--scenario` 模式下场景文件是**虚拟的**（只在内存里，不落盘），
 *    因此孪生面查找必须能命中虚拟文件集，否则每个场景都会退化成「文件不存在」。
 *    传 `null` 时（全仓模式）只读磁盘。 */
function checkMirror(file, text, virtualFiles) {
  const decl = text.match(/<!--\s*MIRROR:\s*([^\s>]+)\s*-->/);
  if (!decl) return; // 未声明 → 不查（默认放行，避免误报）

  const mirrorRel = decl[1];
  const dir = path.dirname(file.abs);
  const mirrorAbs = path.join(dir, mirrorRel);

  // 优先查虚拟文件集（按**相对仓库根**的路径匹配），再落回磁盘。
  const dirRel = path.dirname(file.rel) === '.' ? '' : path.dirname(file.rel);
  const virtualRel = dirRel ? `${dirRel}/${mirrorRel}`.replace(/\\/g, '/') : mirrorRel;
  const fromVirtual = virtualFiles && virtualFiles.has(virtualRel)
    ? virtualFiles.get(virtualRel)
    : null;

  if (fromVirtual === null && !fs.existsSync(mirrorAbs)) {
    add(
      'warning',
      file.rel,
      'D9-mirror',
      `声明了孪生面 \`${mirrorRel}\`，但该文件不存在。` +
        `要么补出孪生面，要么删掉 MIRROR 声明（声明与事实必须一致）。`,
      lineAtCharOffset(text, decl.index),
    );
    return;
  }

  // 孪生面存在 → 校验它是否也认这份声明（双向可达）。只读，不比对正文，
  // 避免把 `.html` 的标签差异当成漂移。
  let mirrorText;
  if (fromVirtual !== null) {
    mirrorText = fromVirtual;
  } else {
    try {
      mirrorText = fs.readFileSync(mirrorAbs, 'utf8');
    } catch (err) {
      add(
        'warning',
        file.rel,
        'D9-mirror',
        `孪生面 \`${mirrorRel}\` 不可读：${err && err.message ? err.message : err}`,
        lineAtCharOffset(text, decl.index),
      );
      return;
    }
  }

  const base = path.basename(file.rel);
  // ⚠️ 生成的 `.html` 里注释是**转义后**的可见文本（`&lt;!-- MIRROR: X --&gt;`），
  //    因为 `build_docs_site.js` 的 `escapeHtml()` 对整行无条件转义，不保留原始注释语义
  //    （实测：`.html` 里 `RULES-REGISTRY` 标记也是 `&lt;!-- ... --&gt;` 形态）。
  //    因此反向可达性判定必须接受两种形态，否则真孪生对会被永久误报。
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reverseSeen =
    new RegExp(`MIRROR:\\s*${escapedBase}`).test(mirrorText) ||
    new RegExp(`MIRROR:\\s*${escapedBase}`).test(
      mirrorText.replace(/&lt;!--/g, '<!--').replace(/--&gt;/g, '-->'),
    );
  if (!reverseSeen) {
    add(
      'warning',
      file.rel,
      'D9-mirror',
      `孪生面 \`${mirrorRel}\` 未反向声明回 \`${base}\`（缺 \`<!-- MIRROR: ${base} -->\`）。` +
        `单向声明时，改任意一面都不会提醒改另一面 —— 这正是 HQ \`drivability\` 原先拦住的那类漂移。`,
      lineAtCharOffset(text, decl.index),
    );
  }
}

/** D5 机器管理块闸 —— khy-metadata:pointer 必须成对，否则 khy metadata link 无法维护。 */
function checkManagedBlock(file, text) {
  const starts = (text.match(/khy-metadata:pointer START/g) || []).length;
  const ends = (text.match(/khy-metadata:pointer END/g) || []).length;
  if (starts === ends) return;
  const startHit = text.match(/khy-metadata:pointer START/);
  const endHit = text.match(/khy-metadata:pointer END/);
  const anchor = startHit || endHit;
  add(
    'error',
    file.rel,
    'D5-managed-block',
    `机器管理块不成对：START ${starts} 个 / END ${ends} 个。该块由 \`khy metadata link\` 覆写，缺标记会导致维护器找不到边界。`,
    anchor ? lineAtCharOffset(text, anchor.index) : 1,
  );
}

/** D6 落点闸 —— 指令文件只在「会被读到」的位置生效。 */
function checkLocation(file, rootWhitelist, rootDocExt) {
  if (file.rel.startsWith('_产物/')) {
    add(
      'error',
      file.rel,
      'D6-location',
      'AI 指令文件放在 _产物/（资产暂存区）内 —— 读取器不扫该目录，文件永不生效，且内容易与真源漂移。',
    );
  }
  const top = file.rel.split('/')[0];
  if (top === '_产物' || top === '.research-tmp') return;
  // 根级分支只对「说明性文件」（.md/.txt）生效 —— 与所引真源 [MGMT-STD-001] §1.3
  // 及 check-repo-layout.js 的 ROOT_DOC_EXT_RE 保持一致。无扩展名的生态层指令文件
  // （.windsurfrules / .clinerules / .cursorrules）不在此闸范围内。
  if (!file.rel.includes('/') && rootDocExt.test(file.rel) && !rootWhitelist.has(file.rel)) {
    add(
      'warning',
      file.rel,
      'D6-location',
      `根目录 AI 指令文件「${file.rel}」不在 check-repo-layout.js 的 ROOT_DOC_WHITELIST 内。` +
        `新增根级说明性文件须先登记白名单（真源 [MGMT-STD-001] §1.3，封闭集合）。`,
    );
  }
}

/** D7 语言策略双口径闸 —— 根 AGENTS.md 是语言策略真源，复述必须一致。
 *
 *  只比对**断言行**：标题（`## 五、代码风格与语言策略`）提到「语言策略」不等于
 *  给出了一条规定，把标题算成「不一致口径」是纯噪声（踩过）。
 */
const RE_LANG_CLAIM = /(语言策略|语言锁|仅英文|用中文回复|reply in Chinese)/;
/** 断言行（带 1-based 行号）；标题不算断言。 */
function assertionLines(text) {
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((item) => item.text && !/^#{1,6}\s/.test(item.text)); // 排标题
}
function checkLanguageSingleVoice(files) {
  const rootAgents = files.find((f) => f.rel === 'AGENTS.md');
  if (!rootAgents) return;
  const truthLines = new Set(
    assertionLines(rootAgents.text)
      .filter((item) => RE_LANG_CLAIM.test(item.text))
      .map((item) => item.text),
  );
  for (const file of files) {
    if (file.rel === 'AGENTS.md') continue;
    const claims = assertionLines(file.text).filter((item) => RE_LANG_CLAIM.test(item.text));
    if (!claims.length) continue;
    const conflicting = claims.filter((item) => !truthLines.has(item.text));
    if (!conflicting.length) continue;
    add(
      'warning',
      file.rel,
      'D7-language',
      `复述了语言策略但措辞与真源（AGENTS.md「语言策略」节）不一致，共 ${conflicting.length} 行。` +
        `两套口径必然漂移 —— 应改为指针，或与真源逐字一致。例：${conflicting[0].text.slice(0, 60)}…`,
      conflicting[0].line,
    );
  }
}

/** D8 逐字重复闸 —— 跨文件重复段落必然漂移（机器管理块除外）。
 *
 *  finding 的 `file` 只能是**单个路径**：ruleguard 的 `FINDING_LINE` 用 `\S+` 抓文件名，
 *  写成 `A.md + B.md` 会让整条 finding 解析失败（进而被当成 unmapped 丢掉）。
 *  其余文件放进 message。
 */
function checkDuplication(files) {
  const strip = (t) =>
    t.replace(/<!-- khy-metadata:pointer START[\s\S]*?khy-metadata:pointer END -->/g, '');
  const index = new Map();
  for (const file of files) {
    const raw = strip(file.text);
    const blocks = raw.split(/\n\s*\n/);
    let cursor = 0;
    for (const block of blocks) {
      const at = raw.indexOf(block, cursor);
      if (at >= 0) cursor = at + block.length;
      const norm = block.trim().replace(/\s+/g, ' ');
      if (norm.length < 160) continue;
      if (!index.has(norm)) index.set(norm, []);
      index.get(norm).push({ rel: file.rel, line: lineAtCharOffset(raw, at >= 0 ? at : 0) });
    }
  }
  const reported = new Set();
  for (const [, owners] of index) {
    const seenRel = new Map();
    for (const owner of owners) if (!seenRel.has(owner.rel)) seenRel.set(owner.rel, owner.line);
    const unique = [...seenRel.keys()].sort();
    if (unique.length < 2) continue;
    const key = unique.join('|');
    if (reported.has(key)) continue;
    reported.add(key);
    const [first, ...rest] = unique;
    add(
      'warning',
      first,
      'D8-duplication',
      `存在 ≥160 字符的逐字重复段落，涉及 ${unique.length} 个文件：${unique.join(' / ')}。` +
        `重复内容会各自漂移，应保留一处（建议 ${first}）+ 其余改指针。`,
      seenRel.get(first),
    );
    if (rest.length) {
      // 每个参与文件各报一条，才能各自被 khy-allow 定位（否则其余文件无处豁免）。
      for (const rel of rest) {
        add(
          'warning',
          rel,
          'D8-duplication',
          `与 ${first} 存在 ≥160 字符的逐字重复段落（同一重复簇：${unique.join(' / ')}）。`,
          seenRel.get(rel),
        );
      }
    }
  }
}

// ── 反例矩阵（--scenario）──────────────────────────────────────────────────
//
// 每个场景注入一份**虚拟文件**，用同一批纯函数跑，证明每条检查既能拦、也能放行。
const SCENARIOS = {
  'budget-overflow': {
    // own 层（`khy.md`）才有 8000 字符预算 —— 真源 instructionFileService.js。
    desc: 'own 层 khy.md 超出 8000 字符预算 → 期望 D1-budget',
    files: [{ rel: 'khy.md', tier: 'own', text: 'x'.repeat(9000) }],
  },
  'budget-within': {
    desc: 'own 层 khy.md 在预算内 → 期望**无** D1 finding（证明不是无脑拦）',
    files: [{ rel: 'khy.md', tier: 'own', text: '# ok\n' + 'x'.repeat(4000) }],
  },
  'budget-compat-exempt': {
    // 反向对照：compat 层由 prompts.js 全量注入、无字符预算 → 22668 字符的
    // AGENTS.md 也不该报 D1（曾误报「只见 35.3%」，实测为假）。
    desc: 'compat 层 AGENTS.md 超 8000 字符 → 期望**放行**（无读取预算）',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# ok\n' + 'x'.repeat(9000) }],
  },
  'budget-eco-overflow': {
    desc: 'eco 层超出 4000 字符预算 → 期望 D1-budget',
    files: [{ rel: '.windsurfrules', tier: 'eco', text: 'x'.repeat(4500) }],
  },
  'precedence-usurp': {
    desc: '子级文件自封「以本文件为准」→ 期望 D2-precedence',
    files: [
      {
        rel: 'services/backend/src/cli/tui/AGENTS.md',
        tier: 'compat',
        text: '# TUI\n\n当本文件与根目录 AGENTS.md 冲突时，以本文件为准。\n',
      },
    ],
  },
  'precedence-ordinary-wording': {
    // 放行对照：「优先于」的宾语不是指令文件时属普通措辞，曾误报
    // （实测 `tui/AGENTS.md:27`「✅ 新增文件优先于修改现有文件」）。
    desc: '「优先于」用于普通编码指引 → 期望**放行**',
    files: [
      {
        rel: 'services/backend/src/cli/tui/AGENTS.md',
        tier: 'compat',
        text: '# TUI\n\n✅ 新增文件优先于修改现有文件\n',
      },
    ],
  },
  'dead-npm-script': {
    desc: '引用不存在的 npm 脚本 → 期望 D3a error',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n跑 `npm run does-not-exist` 即可。\n' }],
  },
  'dead-cli-command': {
    desc: '引用未注册的 CLI 命令 → 期望 D3b warning',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n执行 `khy frobnicate --all` 即可。\n' }],
  },
  'live-cli-command': {
    desc: '引用真实可达的 CLI 命令（metadata 靠自注册可达）→ 期望**无** finding（放行对照）',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n执行 `khy metadata refresh` 刷新。\n' }],
  },
  'unknown-rule-id': {
    desc: '引用未登记的规则 ID → 期望 D3c warning',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n见 `[DOCS-999]`。\n' }],
  },
  'dead-path': {
    desc: '引用不存在的仓库路径（根锚定）→ 期望 D3d warning',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n真源在 `services/nope/missing.js`。\n' }],
  },
  'relative-shorthand': {
    desc: '文件内相对简写路径（首段非顶层目录）→ 期望**无** finding（放行对照）',
    files: [{ rel: 'services/demo/AGENTS.md', tier: 'compat', text: '# X\n\n见 `ink-components/Viewport.js`。\n' }],
  },
  'missing-marker': {
    desc: '正文引用已登记规则但无标记行 → 期望 D4-marker',
    files: [{ rel: 'apps/demo/CLAUDE.md', tier: 'compat', text: '# X\n\n本条对应 `[PROCESS-001]` 与 `[SECURITY-001]`。\n' }],
  },
  'broken-managed-block': {
    desc: '机器管理块只有 START 没有 END → 期望 D5 error',
    files: [
      {
        rel: 'AGENTS.md',
        tier: 'compat',
        text: '# X\n<!-- khy-metadata:pointer START — managed by `khy metadata link` -->\n正文\n',
      },
    ],
  },
  'wrong-location': {
    desc: '指令文件落在 _产物/ → 期望 D6 error',
    files: [{ rel: '_产物/khy.md', tier: 'own', text: '# Y-CODE CLI Development Guidelines\n' }],
  },
  'root-md-not-whitelisted': {
    // 反向对照：证明 D6 的根级分支**没有被那道扩展名闸整条废掉** ——
    // 根目录的**说明性 `.md`**（.md 在 [MGMT-STD-001] §1.3 辖区内）仍须登记白名单。
    desc: '根目录 .md 不在白名单 → 期望 D6 warning',
    files: [{ rel: 'NOTES.md', tier: 'eco', text: '# 随手记\n' }],
  },
  'root-eco-dotfile': {
    // 正向对照：`[MGMT-STD-001]` §1.3 的管辖范围**显式限于 `.md`/`.txt`**，
    // 无扩展名的生态层指令文件（由 `khy metadata link` 生成、已在
    // `instructionEcosystemRegistry.js` 声明）不在此闸范围内 → 期望**放行**。
    desc: '根目录无扩展名生态文件（.windsurfrules）→ 期望放行',
    files: [{ rel: '.windsurfrules', tier: 'eco', text: '# rules\n' }],
  },
  'duplication': {
    desc: '两文件含 ≥160 字符逐字重复 → 期望 D8-duplication',
    files: [
      { rel: 'AGENTS.md', tier: 'compat', text: '# A\n\n' + 'REPEATED '.repeat(30) + '\n' },
      { rel: 'CLAUDE.md', tier: 'compat', text: '# B\n\n' + 'REPEATED '.repeat(30) + '\n' },
    ],
  },
  'bad-workspace': {
    desc: '`--workspace` 名不在根 workspaces 里 → 期望 D3a error',
    files: [
      { rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n```\nnpm run --workspace backend test:tui\n```\n' },
    ],
  },
  'contrast-block': {
    desc: '❌/✅ 对照块里的命令是展示文案 → 期望**无** finding（放行对照）',
    files: [
      {
        rel: 'AGENTS.md',
        tier: 'compat',
        text: '# X\n\n**红线**：必须显示动词 + 目标。\n\n```\n❌  运行 bash\n✅  执行 npm run build\n```\n',
      },
    ],
  },
  'subproject-doc-id': {
    desc: '引用子项目 docs/ 里的文档编号（[DESIGN-ARCH-092]）→ 期望**无** finding（放行对照）',
    files: [
      { rel: 'apps/demo/CLAUDE.md', tier: 'compat', text: '# X\n\n以 `[DESIGN-ARCH-092]` 为唯一真源。\n' },
    ],
  },
  'mirror-undeclared': {
    // 承载 D9 分支 A：声明了**不存在**的孪生面 → 声明与事实不一致。
    // 刻意用虚构文件名（不借用仓库真实孪生件），保证场景**确定性** ——
    // 借用真文件时，只要那个文件恰好补上了反向声明，场景就会静默转绿（实测踩过）。
    // 放在**子目录**里：根级 `.md` 会被 D6 白名单闸顺带报一条，噪音会掩盖 D9 断言。
    desc: '声明了不存在的孪生面 → 期望 D9-mirror warning',
    files: [
      {
        rel: 'apps/demo/AGENTS.md',
        tier: 'compat',
        text: '# X\n\n<!-- MIRROR: NO-SUCH-TWIN.html -->\n语言策略：中文优先。\n',
      },
    ],
  },
  'mirror-one-way': {
    // 承载 D9 分支 B：孪生面**存在**，但**没有反向声明** = 单向声明。
    // 这是「改任意一面都不会提醒改另一面」 → 正是 HQ `drivability` 原先拦住的漂移。
    //
    // ⚠️ 场景文件是**虚拟的**（不落盘），所以「孪生面存在」必须靠**两个虚拟文件互相引用**：
    //    只在第一个文件里写声明，第二个文件故意不写反向声明 → 命中分支 B。
    //    不要用仓库真实文件当孪生面：那些文件是否含 MIRROR 会随仓库演进而变，
    //    场景会随之静默转绿（实测踩过：`AGENTS.html` 补上反向声明后本场景失效）。
    desc: '孪生面存在但未反向声明（单向）→ 期望 D9-mirror warning',
    files: [
      {
        rel: 'apps/demo/AGENTS.md',
        tier: 'compat',
        text: '# X\n\n<!-- MIRROR: TWIN.md -->\n语言策略：中文优先。\n',
      },
      { rel: 'apps/demo/TWIN.md', tier: 'compat', text: '# Y\n\n对面是 AGENTS.md，但这里刻意不写 MIRROR 标记。\n' },
    ],
  },
  'mirror-both-ways': {
    // 放行对照 —— 双向声明时必须**零 finding**。
    // 与 `mirror-one-way` 是**成对设计**：同一对虚拟文件，只差第二个文件有没有反向声明。
    // 这两条必须同时存在，否则「单向报错」这个断言证明不了它不是「凡有 MIRROR 就报」。
    desc: '孪生面存在且双向声明 → 期望**放行**',
    files: [
      {
        rel: 'apps/demo/AGENTS.md',
        tier: 'compat',
        text: '# X\n\n<!-- MIRROR: TWIN.md -->\n语言策略：中文优先。\n',
      },
      { rel: 'apps/demo/TWIN.md', tier: 'compat', text: '# Y\n\n<!-- MIRROR: AGENTS.md -->\n对面是 AGENTS.md。\n' },
    ],
  },
  'mirror-no-declaration': {
    // 放行对照 —— 证明 D9 不是「凡指令文件必报」：没声明 MIRROR 就完全不查。
    // 这是**误报回归锁**（公理 A4）：全仓 1000+ 个 `.html` 孪生件里绝大多数
    // 是文档构建产物，把它们全拦下来会淹掉真正的漂移。
    desc: '未声明孪生面 → 期望**放行**（D9 只查显式声明的对）',
    files: [{ rel: 'AGENTS.md', tier: 'compat', text: '# X\n\n语言策略：中文优先。\n' }],
  },
  'clean': {
    desc: '全部合规 → 期望 0 finding（放行对照）',
    files: [
      {
        rel: 'AGENTS.md',
        tier: 'compat',
        text:
          '# AGENTS\n\n<!-- RULES-REGISTRY: PROCESS-001 -->\n\n' +
          '语言策略：用户用中文则回复中文。\n\n见 `[PROCESS-001]`。\n',
      },
    ],
  },
};

// ── 主流程 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { json: false, verbose: false, scenario: null, files: null, listScenarios: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--list-scenarios') opts.listScenarios = true;
    else if (arg.startsWith('--scenario=')) opts.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--files=')) opts.files = arg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log('用法：node scripts/ci/check-agent-docs.js [--json] [--verbose] [--files=a,b] [--scenario=<名>] [--list-scenarios]');
    process.exit(0);
  }
  if (opts.listScenarios) {
    for (const [name, s] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(24)} ${s.desc}`);
    process.exit(0);
  }

  const budgets = readBudgets();
  const truth = readFilenameTruth();
  const rootWhitelist = readRootWhitelist();
  const rootDocExt = readRootDocExt();
  const registry = readRegistry();
  const index = buildRepoIndex();
  const ctx = {
    npmScripts: readNpmScripts(),
    workspaces: readWorkspaces(),
    cliNames: readCliTruth(),
    registry,
    topDirs: index.topDirs,
    basenames: index.basenames,
    docIds: index.docIds,
  };

  let files;
  let mode = 'repo';
  if (opts.scenario) {
    const scenario = SCENARIOS[opts.scenario];
    if (!scenario) {
      console.error(`未知场景「${opts.scenario}」，用 --list-scenarios 查看可用场景。`);
      process.exit(2);
    }
    mode = `scenario:${opts.scenario}`;
    files = scenario.files.map((f) => ({ ...f, abs: path.join(repoRoot, f.rel) }));
  } else {
    const targets = collectTargets(truth, opts.files);
    files = targets.map((t) => ({ ...t, text: fs.readFileSync(t.abs, 'utf8') }));
  }

  // --scenario 模式下场景文件是虚拟的：建一张「相对路径 → 正文」表，
  // 让 D9 的孪生面查找能命中虚拟文件（否则每个场景都退化成「文件不存在」）。
  const virtualFiles = opts.scenario
    ? new Map(files.map((f) => [f.rel.replace(/\\/g, '/'), f.text]))
    : null;

  for (const file of files) {
    checkBudget(file, file.text, budgets, 'error');
    checkPrecedence(file, file.text, registry);
    checkDeadPointers(file, file.text, ctx);
    checkMarker(file, file.text, registry);
    checkManagedBlock(file, file.text);
    checkLocation(file, rootWhitelist, rootDocExt);
    checkMirror(file, file.text, virtualFiles);
  }
  checkLanguageSingleVoice(files);
  checkDuplication(files);

  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ rule: RULE_ID, mode, repoRoot, scanned: files.length, budgets, findings }, null, 2)}\n`,
    );
  } else {
    // stdout 只放 finding（ruleguard 靠 stdout+stderr 解析；诊断信息走 stderr，
    // 免得 `--verbose` 的缩进表格被当成上一条 finding 的 message 正文）。
    for (const f of findings) {
      const tag = f.severity === 'error' ? '[ERROR]' : '[WARN ]';
      process.stdout.write(`${tag} ${f.check} ${f.file}:${f.line}\n`);
      process.stdout.write(`  ${f.message}\n`);
    }
    if (!findings.length) process.stdout.write('（无 finding）\n');

    const out = process.stderr;
    out.write(`AI 指令文件标准守卫（${RULE_ID}）  模式=${mode}\n`);
    out.write(
      `预算真源：own ${budgets.own.perFile} 字符/文件、own 层合并 ${budgets.own.total}（${IFS_REL}）；` +
        `eco ${budgets.eco.perFile} 字符/文件、层内合计 ${budgets.eco.total}（${ECO_REL}）；` +
        `compat（CLAUDE.md/AGENTS.md）由 ${PROMPTS_REL} 全量注入、无字符预算 → 不适用 D1\n`,
    );
    out.write(`扫描 ${files.length} 个指令文件。\n`);
    if (opts.verbose) {
      out.write('\n');
      for (const file of files) {
        const limit = file.tier === 'eco' ? budgets.eco.perFile : budgets.own.perFile;
        const pct = ((Math.min(file.text.length, limit) / file.text.length) * 100).toFixed(1);
        out.write(
          `  [${file.tier.padEnd(6)}] ${file.rel.padEnd(48)} ${String(file.text.length).padStart(7)} 字符  可见 ${pct}%\n`,
        );
      }
    }
  }

  process.stdout.write(`\nSummary: ${errors.length} error(s), ${warnings.length} warning(s).\n`);
  process.exitCode = errors.length || warnings.length ? 1 : 0;
}

main();
