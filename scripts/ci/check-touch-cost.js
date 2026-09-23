#!/usr/bin/env node
'use strict';

/**
 * check-touch-cost.js — 「改一处的实际代价」守卫（[DESIGN-ARCH-127] M1 支撑）。
 *
 * 判定真源：`scripts/lib/touchCostProbe.js`（纯叶子，零 IO）。
 * 本文件只负责**采集事实**（git / 文件系统）并渲染，不含任何判据。
 *
 * 为什么它是一条「守卫」而不是「报告脚本」：
 * 维护成本必须**可回看**。否则减负方案落地后会反弹——没人记得原来的数字是多少。
 * 本守卫把 4 个读数固化成可对比的输出，并在**触点压缩目标未达成**时给出提示。
 *
 * ## 门档语义
 *
 * `gate=commit` + `severity=advisory`：
 * - 恒 `exit 0`（不阻断任何人），符合「先观察后收紧」的四阶段纪律；
 * - 但会出现在 `rules:gate:commit` 的 `action=start` 里 ⇒ 证明它**真的被执行**，
 *   而不是像 `gate=advisory` 那样恒不被 spawn。
 *
 * ## 用法
 *
 *   node scripts/ci/check-touch-cost.js              # 全量读数
 *   node scripts/ci/check-touch-cost.js --json       # 机器可读
 *   node scripts/ci/check-touch-cost.js --changed     # commit 快档（本守卫无改动集依赖，恒跑）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const probe = require('../lib/touchCostProbe.js');

const ROOT = (() => {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return path.resolve(__dirname, '..', '..');
  }
})();

const REG_REL = 'docs/10_规范/registry/RULES-REGISTRY.json';

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e8 }).trim();
  } catch {
    return '';
  }
}

function lines(cmd) {
  const out = sh(cmd);
  return out ? out.split('\n').filter(Boolean) : [];
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    return null;
  }
}

/** 采集全部事实。任何一项失败都降级为 0/空，绝不抛。 */
function collect() {
  const reg = readJson(REG_REL) || { rules: [], meta: {} };
  const rules = Array.isArray(reg.rules) ? reg.rules : [];

  const baseline = {
    trackedFiles: lines('git ls-files').length,
    rules: rules.length,
    ruleCountField: reg.meta && reg.meta.ruleCount,
    ruleCards: lines('git ls-files -- "docs/10_规范/规则卡/*.md"').length,
    docMd: lines('git ls-files -- "docs/**/*.md"').length,
    docHtml: lines('git ls-files -- "docs/**/*.html"').length,
    ciCheckers: lines('git ls-files -- "scripts/ci/*.js"').length,
    npmScripts: (() => {
      const pkg = readJson('package.json');
      return pkg && pkg.scripts ? Object.keys(pkg.scripts).length : 0;
    })(),
  };

  // 样本选「最重的执行器」：被引用点最多的那条
  const SAMPLE = 'check-repo-layout';
  const samplePaths = lines(
    `git grep -l "${SAMPLE}" -- package.json .github .githooks scripts 'docs/**/*.md' '*.md'`
  );

  const backlogRows = lines('git status --porcelain');

  return {
    baseline,
    ruleTouchCost: probe.measureRuleTouchCost(),
    twinBurden: probe.measureTwinBurden({
      docMd: baseline.docMd,
      docHtml: baseline.docHtml,
      ruleCards: baseline.ruleCards,
    }),
    changeBlast: probe.measureChangeBlast({
      sample: SAMPLE,
      referencingFiles: samplePaths.length,
      samplePaths,
    }),
    gateReality: probe.measureGateReality(rules),
    worktreeBacklog: probe.measureBacklog(backlogRows),
  };
}

function render(readings) {
  const b = readings.baseline;
  const t = readings.ruleTouchCost;
  const twin = readings.twinBurden;
  const gate = readings.gateReality;
  const back = readings.worktreeBacklog;
  const blast = readings.changeBlast;

  const L = [];
  L.push('═══ khy-os 维护成本读数 ═══');
  L.push('判据真源：scripts/lib/touchCostProbe.js（纯叶子，零 IO）');
  L.push('');
  L.push('【基线事实】');
  for (const [k, v] of Object.entries(b)) L.push(`  ${String(k).padEnd(24)} ${v}`);
  L.push('');
  L.push('【A. 新增一条规则的触点】');
  for (const d of t.detail) {
    const tag = d.required ? '[必须]' : '[可选]';
    const kind = d.kind === 'auto' ? ' (可派生)' : '';
    L.push(`  ${tag} ${d.name.padEnd(32)}${kind.padEnd(10)} ${d.why}`);
  }
  L.push(`  ⇒ 硬触点 ${t.required} 处（可选 ${t.optional} 处）｜其中可派生 ${t.derivable} 处、必须人写 ${t.manual} 处`);
  L.push(`  ⇒ 压缩目标：${t.required} → ${t.compressionTarget}（1 处语义声明 + 自动派生）`);
  L.push('');
  L.push('【B. 改一条规则判据的波及面】');
  L.push(`  样本 ${blast.sample}：被 ${blast.referencingFiles} 个文件引用`);
  for (const p of blast.samplePaths.slice(0, 8)) L.push(`    - ${p}`);
  L.push('');
  L.push('【C. 文档孪生件负担】');
  L.push(`  .md ${twin.mdFiles} / .html ${twin.htmlFiles}（比 ${twin.ratio}）`);
  L.push(`  规则卡 ${twin.ruleCardPairs} 组｜改一句话至少碰 ${twin.filesPerSentenceEdit} 个文件`);
  L.push('');
  L.push('【D. 阻断强度实况】');
  L.push(`  gate 分布：${JSON.stringify(gate.distribution)}`);
  L.push(`  永不执行（advisory）：${gate.neverExecuteCount} / ${gate.ruleTotal} 条`);
  for (const r of gate.neverExecute.slice(0, 6)) L.push(`    - [${r.priority}] ${r.id}`);
  if (gate.neverExecuteCount > 6) L.push(`    … 其余 ${gate.neverExecuteCount - 6} 条见 --json`);
  L.push('');
  L.push('【E. 工作区积压】');
  L.push(`  M ${back.modified} / D ${back.deleted} / ?? ${back.untracked} = ${back.total}`);

  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  const readings = collect();
  const summary = probe.summarize(readings);

  if (asJson) {
    console.log(JSON.stringify({ readings, summary }, null, 2));
    return 0;
  }

  console.log(render(readings));

  // ── 建议排序（advisory，不阻断）────────────────────────
  console.log('');
  console.log('【该先修哪个（按读数排序，仅建议）】');
  for (const s of summary.signals) {
    console.log(`  ${s.id}  ${String(s.severity).padStart(6)}  ${s.title}｜${s.reading}`);
  }

  const t = readings.ruleTouchCost;
  const findings = [];
  if (t.required > t.compressionTarget) {
    findings.push(
      `新增规则的硬触点为 ${t.required} 处（目标 ${t.compressionTarget} 处）；` +
        `其中 ${t.derivable} 处是可派生的生成物`
    );
  }

  console.log('');
  for (const msg of findings) {
    // ⚠ 用聚合方言（aggregate dialect）：无 file:line，供 ruleguard 解析
    console.log(`- [warn] ${msg} (id: touch-cost-high)`);
  }
  if (findings.length === 0) {
    console.log('✅ 触点压缩目标已达成。');
  }

  console.log(`\nSummary: ${findings.length} warning(s).`);
  return 0; // gate=commit + severity=advisory ⇒ 恒 exit 0，不阻断
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { collect, render };
