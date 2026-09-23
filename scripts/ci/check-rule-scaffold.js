#!/usr/bin/env node
/**
 * check-rule-scaffold.js — 规则接线完整性守卫（`[DESIGN-ARCH-127]` M1）。
 *
 * ## 它挡的是什么
 *
 * 「新增一条规则要同步 13 个文件」是 khy-os 可维护性的头号成本项。
 * 但比「贵」更糟的是「贵且会漂移」——同一个事实写在 N 个地方，就**一定**
 * 会在某些地方漏改，而漏改的地方**没有任何守卫会发现**（因为守卫只校验
 * 「有没有声明」，不校验「N 处是否彼此一致」）。
 *
 * 本守卫把「N 处是否一致」变成一条可跑的检查：
 * 对登记表里每条规则，用 `scripts/lib/ruleScaffold.js` 的声明式触点清单
 * 核对磁盘现状，任何一处缺失/漂移都报出来。
 *
 * ## 与既有守卫的分工（**不重复**）
 *
 * | 守卫 | 管什么 |
 * |---|---|
 * | `check-rules-registry`（TOOLING-007/008） | 登记表 ↔ 真源**双向可达** + 规则卡逐字节一致 |
 * | `check-wiring` | 检查器是否被**门表面引用** |
 * | **本守卫** | **登记表 ↔ 磁盘 13 处触点的完整性**，并显式列出 `gate=advisory` 的永不执行规则 |
 *
 * 三者**互补不重叠**：前两者判「拓扑正确」，本守卫判「接线的每一段都在」。
 *
 * ## 强度
 *
 * `gate=commit` + `severity=advisory`（**只记录不拦截**）。
 * ⚠ 刻意**不用** `gate='advisory'` —— 那个值在任何门档都不会被执行
 * （`GATE_ORDER.advisory=4 > max=2`），用了等于没接。
 * 这也正是本守卫要暴露给全仓的那个陷阱。
 *
 * Usage: node scripts/ci/check-rule-scaffold.js [--json] [--changed] [--list]
 * Fixture root: KHY_SCAFFOLD_ROOT=/path/to/repo node scripts/ci/check-rule-scaffold.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_SCAFFOLD_ROOT
  ? path.resolve(process.env.KHY_SCAFFOLD_ROOT)
  : path.resolve(__dirname, '..', '..');

const REGISTRY_REL = 'docs/10_规范/registry/RULES-REGISTRY.json';
const PKG_REL = 'package.json';
const FINDING_ID = 'rule-scaffold-gap';
const ADVISORY_FINDING_ID = 'advisory-never-executes';

const guard = require('../lib/ruleScaffold.js');

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const listMode = args.includes('--list');

const findings = [];

function addFinding(id, file, message) {
  findings.push({ id, file, message });
}

function readText(relPath) {
  const abs = path.join(repoRoot, relPath);
  try {
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  } catch (err) {
    return null;
  }
}

function exists(relPath) {
  if (!relPath) return false;
  try {
    return fs.existsSync(path.join(repoRoot, relPath));
  } catch (err) {
    return false;
  }
}

// ── 构建事实提供器（唯一的 IO 边界；判定逻辑全在叶子里）────────
function buildCtx(registry) {
  const pkg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(repoRoot, PKG_REL), 'utf8'));
    } catch (err) {
      return { scripts: {} };
    }
  })();
  const scripts = pkg.scripts || {};

  // 别名判据：某个 npm script 的值里出现该执行器路径
  // ⚠ 不能只比对「别名名字等于执行器名」——本仓 248 个 script 的命名并不规则，
  //   唯一可靠的判据是「执行器路径真的被某个 script 引用」。
  const scriptValues = Object.values(scripts).map(String);
  const hasAliasFor = (scriptPath) => {
    if (!scriptPath) return null;
    const norm = scriptPath.replace(/\\/g, '/');
    return scriptValues.some((v) => v.replace(/\\/g, '/').includes(norm));
  };

  // 标记行判据：<!-- RULES-REGISTRY: ID --> 或 // RULES-REGISTRY: ID
  const markerCache = new Map();
  const hasRegistryMarker = (relPath, ruleId) => {
    if (!relPath) return null;
    if (!markerCache.has(relPath)) {
      const text = readText(relPath);
      markerCache.set(relPath, text);
    }
    const text = markerCache.get(relPath);
    if (text === null) return null; // 文件不存在 ⇒ 交由 exists 触点报，不在此重复
    const re = /^[ \t]*(?:<!-- |\/\/ )?RULES-REGISTRY:\s*([^\n]*?)(?: -->)?[ \t]*$/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const ids = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.includes(ruleId)) return true;
    }
    return false;
  };

  return { registryPath: REGISTRY_REL, exists, hasAliasFor, hasRegistryMarker };
}

/**
 * `--changed` 模式：只报**本次改动涉及的规则**。
 *
 * ⚠ 判据是「规则的 ssot / 执行器 / 规则卡路径是否落在改动集里」，
 * 而不是「规则 id 是否出现在 diff 文本里」——后者会把「文档里提到某规则」误判成「该规则被改」。
 */
function changedRuleIds(registry) {
  const { execSync } = require('child_process');
  let changed = [];
  try {
    const out = execSync('git diff --cached --name-only', { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1e8 });
    changed = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    return null; // 拿不到改动集 ⇒ 退化为全量
  }
  if (changed.length === 0) return [];
  const set = new Set(changed.map((p) => p.replace(/\\/g, '/')));
  const ids = new Set();
  for (const r of registry.rules || []) {
    const paths = [];
    // ⚠ 必须用 ssotFilePaths（已剥离 `§N` / `#anchor` / 命令项）——
    //   直接用 ssotFiles 会把 `CLAUDE.md#一红线-r1-r4（R4）` 当路径，永不命中改动集。
    for (const f of guard.ssotFilePaths(r)) paths.push(f);
    if (r.exec && r.exec.script) paths.push(r.exec.script);
    paths.push(`docs/10_规范/规则卡/[${r.id}] ${r.name}.md`);
    if (paths.some((p) => set.has(String(p).replace(/\\/g, '/')))) ids.add(r.id);
  }
  return [...ids];
}

// ── 主流程 ─────────────────────────────────────────────────
function main() {
  if (!exists(REGISTRY_REL)) {
    console.error(`[ERROR] ${FINDING_ID} ${REGISTRY_REL}\n  登记表不存在，无法审计`);
    console.error('\nSummary: 1 error(s), 0 warning(s).');
    return 1;
  }

  let registry;
  try {
    registry = JSON.parse(readText(REGISTRY_REL));
  } catch (err) {
    console.error(`[ERROR] ${FINDING_ID} ${REGISTRY_REL}\n  登记表不是合法 JSON：${err.message}`);
    console.error('\nSummary: 1 error(s), 0 warning(s).');
    return 1;
  }

  // ① 登记表自洽（第一处会漂移的真源）
  const self = guard.checkRegistrySelfConsistency(registry);
  for (const e of self.errors) {
    addFinding(FINDING_ID, REGISTRY_REL, `登记表自身不一致：${e}`);
  }

  // ② 逐条规则审计 13 处触点
  const ctx = buildCtx(registry);
  const audit = guard.auditRegistry(registry, ctx);

  const changed = args.includes('--changed') ? changedRuleIds(registry) : null;
  const changedSet = changed ? new Set(changed) : null;

  for (const r of audit.results) {
    if (!r.ok) {
      if (changedSet && !changedSet.has(r.ruleId)) continue;
      for (const g of r.gaps) {
        addFinding(FINDING_ID, g.path || REGISTRY_REL, `[${r.ruleId}] ${g.label}：${g.note}`);
      }
    }
  }

  // ③ M2 结构性判据：advisory 规则永不执行
  //
  // ⚠ `--changed` 下**只报改动集里的**规则：advisory 是**全仓存量盘点**（15 条恒存），
  //   若在 commit 快档里每次都报全量，它会变成纯噪声而被整体忽略。
  //   判据：规则自身被改（ssot / 执行器 / 规则卡路径落在改动集里）。
  const neverExec = guard.findNeverExecuting(registry);
  for (const r of guard.sortByPriority(neverExec)) {
    if (changedSet && !changedSet.has(r.id)) continue;
    addFinding(
      ADVISORY_FINDING_ID,
      REGISTRY_REL,
      `[${r.id}] ${r.priority} gate='advisory' ⇒ 任何门档都不会执行它（GATE_ORDER.advisory=4 > max=2）。${r.fix}`
    );
  }

  // ── 输出 ──
  // ⚠ 门里的消费者只认两种方言（`scripts/ruleguard/lib/run.js`）：
  //   ① 逐条：`[ERROR|WARN ] <finding> <file>:<line>`（定宽 6 字符的标签，**必须顶格、单行**）
  //   ② 聚合：`- [warn] <说明> (id: <finding>)`（无 file:line，用于「按次数/存量」类 findings）
  // 本守卫报的是**存量盘点**（每条 finding 对应一处接线缺口，但没有「行号」这种位置概念），
  // 故走聚合方言 —— 与 `check-repo-layout.js` 同一口径。
  // 初版写成「两行 + 缩进」的形态 ⇒ ruleguard 完全解析不出（报 exit=1 且
  // `errors=0 warnings=0`），而人类看输出却像是「报了 15 条」⇒ 典型静默失真。
  if (jsonMode) {
    console.log(JSON.stringify({
      audit: { total: audit.total, okCount: audit.okCount, withGaps: audit.withGaps },
      neverExecuting: neverExec,
      findings,
    }, null, 2));
    console.log(`\nSummary: ${findings.length} error(s), 0 warning(s).`);
    return findings.length > 0 ? 1 : 0;
  }

  if (listMode) {
    console.log(`[check-rule-scaffold] 触点清单（唯一真源：scripts/lib/ruleScaffold.js TOUCHPOINTS）`);
    for (const tp of guard.TOUCHPOINTS) {
      console.log(`  ${tp.kind === guard.KIND.AUTO ? '[自动]' : '[人工]'} ${tp.id.padEnd(18)} ${tp.label}`);
    }
    console.log(`\n规则总数 ${audit.total}｜接线完整 ${audit.okCount}｜有缺口 ${audit.withGaps}`);
    console.log(`advisory（永不执行）${neverExec.length} 条`);
    return 0;
  }

  console.log('check-rule-scaffold: 规则接线完整性守卫（[DESIGN-ARCH-127] M1）');
  console.log('判定真源：scripts/lib/ruleScaffold.js（纯叶子，零 IO）');
  console.log(`规则总数 ${audit.total}｜接线完整 ${audit.okCount}｜有缺口 ${audit.withGaps}`);
  console.log(`advisory（永不执行）${neverExec.length} 条`);
  console.log('');

  // 聚合方言：每条 finding 一行，供 ruleguard 解析。
  // 全部记 warning —— 本规则 gate=commit + severity=advisory，**只记录不拦截**；
  // 把标签写成 [error] 会与 severity=advisory 矛盾（也让 Summary 的语义失真）。
  for (const f of findings) {
    console.log(`- [warn] ${f.message} (id: ${f.id})`);
  }

  if (findings.length === 0) {
    console.log('✅ 全部规则的接线完整，且无 advisory 永不执行项。');
  }
  console.log(`\nSummary: ${findings.length} warning(s).`);
  return 0; // gate=commit + severity=advisory ⇒ 恒 exit 0，不阻断
}

process.exitCode = main();
