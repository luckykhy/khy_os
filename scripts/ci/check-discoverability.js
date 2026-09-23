#!/usr/bin/env node
'use strict';

/**
 * check-discoverability.js — 层级可发现性守卫（规则 LAYOUT-006 / 真源 [DESIGN-LAY-006]）。
 *
 * 与 check-repo-layout.js（LAYOUT-001，管「顶层目录登没登记」）正交互补：
 *   本守卫管**层内**「一个目录里的东西读者找不找得到」。
 *
 * 默认 advisory（恒 exit 0）：存量违规多，过早阻断会逼维护者绕过门禁。
 * `--strict` 时若有 error 则 exit 1（迁移完成后由 [DESIGN-LAY-006] §8 升为 pr 档）。
 *
 * 用法：
 *   node scripts/ci/check-discoverability.js                    # 全仓扫描，advisory
 *   node scripts/ci/check-discoverability.js --strict           # 有 error 即 exit 1
 *   node scripts/ci/check-discoverability.js --json             # 机器可读
 *   node scripts/ci/check-discoverability.js --list=flat-overflow
 *   node scripts/ci/check-discoverability.js --top=20           # 只报最挤的 N 个
 */

const fs = require('fs');
const path = require('path');
const guard = require('../lib/discoverabilityGuard');

const ROOT = process.env.KHY_DISCOVERABILITY_ROOT || path.join(__dirname, '..', '..');
const BASELINE_REL = 'scripts/ci/discoverability-baseline.json';

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

const strict = arg('strict') === true;
const asJson = arg('json') === true;
const listId = arg('list');
const topN = Number(arg('top')) || 0;

// 顶层扫描起点（跳过大目录）
const SKIP_TOP = new Set(['node_modules', '.git', '.khy', 'tmp-cmp']);
// 递归最大深度：本仓实测最深有意义层级约 6
const MAX_DEPTH = Number(arg('depth')) || 6;

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

// 走盘：对每个目录喂给纯叶子的 inspectDir
function scanTree() {
  const findings = [];
  const visited = [];

  function walk(rel) {
    const abs = rel ? path.join(ROOT, rel) : ROOT;
    const ents = readDirSafe(abs);
    if (!ents.length) return;
    const depth = rel ? rel.split(path.sep).length : 0;
    if (rel && depth > MAX_DEPTH) return;

    // 顶层跳过项
    if (!rel) {
      const names = new Set(ents.map((e) => e.name));
      for (const s of SKIP_TOP) names.delete(s);
    }

    const entries = [];
    for (const e of ents) {
      if (!rel && SKIP_TOP.has(e.name)) continue;
      if (e.name === '.git') continue;
      entries.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' });
    }

    const dirRel = rel ? rel.split(path.sep).join('/') : '.';
    const dirFindings = guard.inspectDir(dirRel, entries);
    if (dirFindings.length) {
      findings.push(...dirFindings);
      visited.push({ dir: dirRel, entries: entries.length });
    }

    // 文档索引编组检查
    if (/^docs(\/|$)/.test(dirRel) && dirFindings.length) {
      const idxName = entries.map((e) => e.name).find((n) => /^00_INDEX_/.test(n) && /\.md$/.test(n));
      if (idxName) {
        let text = '';
        try {
          text = fs.readFileSync(path.join(abs, idxName), 'utf8');
        } catch (e) { text = ''; }
        findings.push(...guard.inspectIndex(`${dirRel}/${idxName}`, text));
      } else {
        findings.push({
          id: 'missing-index',
          strength: 'error',
          path: dirRel,
          detail: `目录 "${dirRel}" 条目超预算却没有 00_INDEX_*.md 编组索引。`,
        });
      }
    }

    // 继续下钻（跳过豁免名）
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (guard.isExemptName(e.name)) continue;
      if (!rel && SKIP_TOP.has(e.name)) continue;
      walk(rel ? path.join(rel, e.name) : e.name);
    }
  }

  walk('');
  return { findings, visited };
}

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_REL), 'utf8'));
  } catch (e) {
    return null;
  }
}

function main() {
  if (!guard.isEnabled()) {
    console.log('check-discoverability: 已由 KHY_DISCOVERABILITY_GUARD 关闭。');
    process.exit(0);
  }

  const { findings: raw, visited } = scanTree();
  let findings = raw;

  if (listId) {
    findings = findings.filter((f) => f.id === listId);
    if (!findings.length) {
      console.log(`check-discoverability: --list=${listId} 无发现。`);
      console.log(`可用 id: flat-overflow, missing-index, no-grouping, empty-index`);
      process.exit(2); // 拼错 id 不静默放过
    }
  }

  findings.sort((a, b) => (b.over || 0) - (a.over || 0));
  if (topN > 0) findings = findings.slice(0, topN);

  const s = guard.summarize(findings);
  const baseline = readBaseline();

  // ── --verify-baseline：基线「只降不升」棘轮 + 扫描幂等 ──────────────────
  // 供 CI 作业 discoverability-roundtrip 使用（[DESIGN-LAY-006] §7 步骤3）。
  // 上调基线让 CI 变绿是本规范最常见的绕过手法，这里把它变成机器判定。
  if (arg('verify-baseline') === true) {
    if (!baseline || !baseline.counts) {
      console.error('check-discoverability: 基线文件缺失或不可解析 —— 守卫失去判据。');
      process.exit(1);
    }
    const counts = { 'flat-overflow': 0, 'no-grouping': 0 };
    for (const f of findings) if (counts[f.id] !== undefined) counts[f.id] += 1;

    // ① 幂等：再扫一次，findings 的 id+path 集合必须逐条一致（顺序无关）
    const { findings: raw2 } = scanTree();
    const key = (arr) => arr.map((f) => `${f.id}\u0000${f.path}`).sort().join('\n');
    const idem = key(findings) === key(raw2);

    let bad = 0;
    for (const [id, measured] of Object.entries(counts)) {
      const allowed = baseline.counts[id];
      if (allowed === undefined) continue;
      if (measured > allowed) {
        console.error(`✗ 基线漂移（上调）：${id} 基线 ${allowed}，实测 ${measured}（超出 ${measured - allowed}）。`);
        console.error('  只降不升 —— 降低基线的唯一合法方式是按 [DESIGN-LAY-006] §4 拆分并清理壳后 --update-baseline。');
        bad += 1;
      } else {
        console.log(`✓ ${id}: 实测 ${measured} ≤ 基线 ${allowed}`);
      }
    }
    if (!idem) {
      console.error('✗ 扫描不幂等：同一棵树两次扫描的发现集合不一致（守卫有非确定性）。');
      bad += 1;
    } else {
      console.log('✓ 扫描幂等：两次扫描发现集合一致');
    }
    if (bad > 0) { console.error(`Summary: ${bad} 项失败。`); process.exit(1); }
    console.log('Summary: 基线棘轮与幂等均通过。');
    process.exit(0);
  }

  if (asJson) {
    console.log(JSON.stringify({
      mode: strict ? 'strict' : 'advisory',
      scanned: visited.length,
      baseline: baseline ? baseline.counts : null,
      findings,
      summary: { errors: s.errors, warnings: s.warnings },
    }, null, 2));
  } else {
    console.log('check-discoverability — 规则 LAYOUT-006 / 真源 docs/10_规范/DESIGN-LAY/[DESIGN-LAY-006] 仓库层级可发现性规范.md');
    console.log(`模式：${strict ? 'strict（有 error 即 exit 1）' : 'advisory（只报不改，恒 exit 0）'}　扫描 ${visited.length} 个超预算目录`);
    if (baseline) {
      console.log(`基线：${JSON.stringify(baseline.counts)}（updated ${baseline.updated || '-'}）`);
    }
    console.log('');
    console.log(guard.render(findings));
    console.log('');
    if (s.errors > 0 && !strict) {
      console.log(`提示：当前 ${s.errors} 条 error 属存量，advisory 模式下不阻断。`);
      console.log('      拆分顺序见 [DESIGN-LAY-006] §8 三步接线清单与 §9 分批映射表。');
      console.log('');
    }
    console.log('复现与反例矩阵：node scripts/ci/discoverability-demo.js --all');
  }

  process.exit(strict && s.errors > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { scanTree, readBaseline, BASELINE_REL };
