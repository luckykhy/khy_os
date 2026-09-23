#!/usr/bin/env node
/**
 * check-rules-registry.js — 规则登记表与真源的「双向可达」守卫（TOOLING-007）。
 *
 * RULES-REGISTRY.json 是规则语义的指针登记表，规则正文留在各自的章程 / 规范文档里。
 * 只有单向指针（登记表 → 真源）时，真源文档一旦漂离登记表，两套编号就会并存且无人
 * 发现 —— 读者在正文里查不到自己的规则 ID。本守卫补上反方向：
 *
 *   1. 每条登记规则的语义真源（ssot 首个目标）必须在其文件内以 RULES-REGISTRY
 *      标记行声明该规则 ID（登记表 → 真源可标）。
 *   2. 标记行中出现的 ID 必须已登记（真源 → 登记表可达，禁孤儿标记）。
 *   3. 真源文件与 enforcement 列出的执行 / 常量真源必须存在（禁死指针）。
 *
 * 标记行格式（机器解析，两种写法按文件类型选用）：
 *   Markdown: <!-- RULES-REGISTRY: COMMS-001, COMMS-002 -->
 *   代码:     // RULES-REGISTRY: SECURITY-002
 *
 * 字段完整性、ID 格式、domain / priority / status 枚举、权力-约束配对由
 * check-gov-rules.js（GOV-TOOL-006）负责，本脚本只做可达性。
 *
 * Usage: node scripts/ci/check-rules-registry.js [--changed]
 * Fixture root: KHY_RULES_REGISTRY_ROOT=/path/to/repo node scripts/ci/check-rules-registry.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_RULES_REGISTRY_ROOT
  ? path.resolve(process.env.KHY_RULES_REGISTRY_ROOT)
  : path.resolve(__dirname, '..', '..');

const RULE_ID = 'TOOLING-007';
const CARD_RULE_ID = 'TOOLING-008';
const REGISTRY_REL = 'docs/10_规范/registry/RULES-REGISTRY.json';
const CARD_GEN_REL = 'scripts/docs/gen-rules-cards.js';
const CARD_DIR_REL = 'docs/10_规范/规则卡';
// 扩展名按长度降序排列：正则 alternation 从左到右尝试，`js` 必须排在 `json`
// 之后，否则 `package.json` 会被截断成 `package.js`。
const HOME_EXTS = ['md', 'js', 'cjs', 'mjs', 'json', 'yml', 'yaml', 'py', 'vue', 'ts']
  .sort((a, b) => b.length - a.length);
// 规则 ID 为 <DOMAIN>-<NNN>；DOMAIN 段自身可含连字符（如 MGMT-STD-008）。
const ID_PATTERN = /[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}\b/g;
// 标记行允许两种前缀：HTML 注释（Markdown）与行注释（代码）。
const MARKER_PATTERN = /^[ \t]*(?:<!-- |\/\/ )?RULES-REGISTRY:\s*([^\n]*?)(?: -->)?[ \t]*$/gm;

const changedMode = process.argv.includes('--changed');
const findings = [];

function addFinding(file, message, rule) {
  findings.push({ rule: rule || RULE_ID, file, message });
}

function readText(relPath) {
  const abs = path.join(repoRoot, relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function exists(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

/** `ssot` / `enforcement` 约定：目标以 ' / '（带空格）分隔；单个目标可带
 *  段尾修饰（' §1'、' godFileLoc()'、'（代码即真源）'），它们不属于路径。 */
function splitTargets(value) {
  return String(value || '')
    .split(' / ')
    .map((part) => part.trim())
    .filter(Boolean);
}

function targetPath(target) {
  const match = target.match(new RegExp('^(.*?\\.(?:' + HOME_EXTS.join('|') + '))\\b'));
  return match ? match[1] : null;
}

/** 提取一个文件里所有 RULES-REGISTRY 标记行声明的规则 ID。 */
function markerIds(text) {
  const ids = new Set();
  for (const match of String(text).matchAll(MARKER_PATTERN)) {
    for (const hit of match[1].match(ID_PATTERN) || []) ids.add(hit);
  }
  return ids;
}

/** 改动集 = 已跟踪变更 + 未跟踪新文件。只取 `git diff` 会漏掉新增的规则卡
 *  与登记表（`git diff` 不看 untracked），--changed 模式会因此错误地跳过。 */
function changedFiles() {
  try {
    const { execFileSync } = require('child_process');
    const set = new Set();
    for (const args of [
      ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'],
      ['ls-files', '--others', '--exclude-standard'],
    ]) {
      const out = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const rel = line.trim();
        if (rel) set.add(rel);
      }
    }
    return set;
  } catch (error) {
    return null; // 非 git 检出或无 HEAD：保守起见不跳过
  }
}

/** 返回 { rules, homes }：homes 为 Map<home relPath, Set<rule id>>。 */
function loadRegistry() {
  const text = readText(REGISTRY_REL);
  if (text === null) {
    console.log(`规则登记表缺失，跳过双向可达检查（预期路径 ${REGISTRY_REL}）。`);
    process.exitCode = 0;
    return null;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    addFinding(REGISTRY_REL, `JSON 解析失败：${error.message}（字段与格式见 GOV-TOOL-006）。`);
    return { rules: [], homes: new Map() };
  }

  const rules = Array.isArray(data && data.rules) ? data.rules : [];
  const homes = new Map();

  for (const rule of rules) {
    const id = typeof rule.id === 'string' ? rule.id : '';
    if (!id) continue;

    const targets = splitTargets(rule.ssot);
    if (targets.length === 0) {
      addFinding(REGISTRY_REL, `${id}：ssot 为空，无法定位语义真源。`);
      continue;
    }
    const home = targetPath(targets[0]);
    if (!home) {
      addFinding(REGISTRY_REL,
        `${id}：ssot 首个目标不是文件路径（${targets[0]}），无法定位语义真源。`);
      continue;
    }
    if (!exists(home)) {
      addFinding(REGISTRY_REL, `${id}：语义真源文件不存在 ${home}。`);
      continue;
    }
    if (!homes.has(home)) homes.set(home, new Set());
    homes.get(home).add(id);

    const enforcement = rule.enforcement;
    if (typeof enforcement === 'string' && enforcement.trim()) {
      for (const target of splitTargets(enforcement)) {
        const enforcementPath = targetPath(target);
        if (enforcementPath && !exists(enforcementPath)) {
          addFinding(REGISTRY_REL, `${id}：enforcement 指向不存在的文件 ${enforcementPath}。`);
        }
      }
    }
  }

  // 登记表 → 真源：真源必须声明自己承载的规则 ID
  for (const [home, expected] of homes) {
    const declared = markerIds(readText(home) || '');
    for (const id of expected) {
      if (!declared.has(id)) {
        addFinding(home,
          `${id} 已登记，但真源 ${home} 未以 RULES-REGISTRY 标记行声明，登记表与真源断链。`);
      }
    }
    // 真源 → 登记表：标记行不得出现未登记的 ID
    for (const id of declared) {
      const known = rules.some((r) => r.id === id);
      if (!known) {
        addFinding(home,
          `${id} 在 ${home} 的标记行中声明，但未在 ${REGISTRY_REL} 登记（孤儿标记）。`);
      }
    }
  }

  return { rules, homes };
}

/** 逐条规则卡（[MGMT-STD-008] §1）必须与登记表逐字节一致（TOOLING-008）。
 *
 * 不在这里重新实现卡片渲染逻辑：守卫若自带一份渲染代码，就成了同一段逻辑的
 * 第二份副本，恰好违反本规则要防的「两套真源漂移」。改为调用生成器的
 * --check 模式，把「卡与登记表是否分叉」收敛成一条脏 diff 判断。 */
function checkRuleCards() {
  if (!exists(CARD_GEN_REL)) {
    addFinding(CARD_DIR_REL,
      `规则卡生成器 ${CARD_GEN_REL} 不存在，无法校验卡片与登记表的一致性。`,
      CARD_RULE_ID);
    return;
  }

  try {
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, [path.join(repoRoot, CARD_GEN_REL), '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stdout || '').trim()
      || String(error.stderr || '').trim()
      || String(error.message);
    addFinding(CARD_DIR_REL,
      `规则卡产物与 ${REGISTRY_REL} 不一致（卡片缺失、被手改或生成器过期）：${detail.replace(/\n+/g, ' | ')}（TOOLING-008：重新运行 node ${CARD_GEN_REL}）。`,
      CARD_RULE_ID);
    return;
  }
}

/** 规则卡目录里每张 `[<ID>] <name>.md` 都必须对应一条已登记规则（TOOLING-008）。
 *
 * 生成器的 --check 只遍历「它自己会生成的文件」，所以多出来的孤儿卡片对它
 * 是不可见的——这里补上目录枚举。00_INDEX_* 是目录索引，豁免。 */
function checkOrphanCards(registeredIds) {
  const dir = path.join(repoRoot, CARD_DIR_REL);
  if (!fs.existsSync(dir)) return;
  const cardName = /^\[([A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3})\] .+\.md$/;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('00_INDEX_')) continue;
    const match = cardName.exec(entry);
    if (!match) continue;
    if (!registeredIds.has(match[1])) {
      addFinding(CARD_DIR_REL,
        `孤儿规则卡 ${entry}：其 ID ${match[1]} 未在 ${REGISTRY_REL} 登记。`,
        CARD_RULE_ID);
    }
  }
}

function printSummary() {
  if (findings.length === 0) {
    console.log('规则登记体系检查通过：GOV-TOOL-006 校验字段，TOOLING-007 校验登记表与真源标记行双向一致，TOOLING-008 校验规则卡与登记表逐字节一致。');
    return 0;
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.message.localeCompare(b.message));
  for (const finding of findings) {
    console.error(`[ERROR] ${finding.rule} ${finding.file}\n  ${finding.message}`);
  }
  console.error(`\nSummary: ${findings.length} rule-registry error(s).`);
  return 1;
}

function main() {
  const loaded = loadRegistry();
  if (loaded === null) return 0; // registry absent: skipped above

  if (changedMode) {
    const changed = changedFiles();
    if (changed !== null) {
      const relevant = changed.has(REGISTRY_REL)
        || changed.has(CARD_GEN_REL)
        || [...loaded.homes.keys()].some((home) => changed.has(home))
        || [...changed].some((rel) => rel.startsWith(CARD_DIR_REL + path.sep)
          || rel.startsWith(CARD_DIR_REL + '/'));
      if (!relevant) {
        console.log('本次改动未触及规则登记表、规则卡或任何规则真源，跳过规则登记体系检查。');
        return 0;
      }
    }
  }

  checkRuleCards();
  checkOrphanCards(new Set(loaded.rules.map((rule) => rule.id)));
  return printSummary();
}

process.exitCode = main();
