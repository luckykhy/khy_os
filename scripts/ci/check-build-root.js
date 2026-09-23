#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 *
 * check-build-root.js — 守住「所有构建产物落在唯一产物根 `entries/` 下、且删了能重建」这条线。
 * 执行者：规则 LAYOUT-005 / 真源 docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] 构建产物单一根规范.md
 *
 *   node scripts/ci/check-build-root.js                 # advisory：只报不改，恒 exit 0
 *   node scripts/ci/check-build-root.js --strict        # 有 error 即 exit 1（步骤 3 收口后启用）
 *   node scripts/ci/check-build-root.js --json          # 机器可读
 *   node scripts/ci/check-build-root.js --list=outside-root   # 打某条 finding 的全量清单
 *   node scripts/ci/check-build-root.js --audit-clean   # 体检 clean.js 清理登记表与磁盘的缺口
 *
 * ## 为什么默认 advisory 而不是直接 error
 *
 * 本仓当前 24 个产物目录散在 6 个层级，存量不可能在一个 PR 里迁完。一上来就 error
 * 只会得到两种结果：要么没人跑这个检查，要么有人往登记表里填假数据换绿灯——
 * 后者比不检查更糟，因为它把「未迁移」伪装成「已迁移」。所以：
 *   步骤 1「标记」= 本文件 + advisory（恒 0）
 *   步骤 2「迁移」= 升 pr gate，只报 warning
 *   步骤 3「收口」= --strict 接进门档
 * 一次提交只做一步（SOURCING-006）。
 *
 * ## 为什么判定输入是登记表而不是白名单
 *
 * 原 `check-build-artifacts.js` 的 scope 只有 `apps/khy-mobile/android/` 一条，实测
 * 它绿着放行 10 个已被 git 跟踪的产物（`apps/khyos-desktop/out/**` + `kernel/moonbit/_build/.moon-lock`）。
 * 路径白名单永远追不上工具的输出路径，所以这里改成「磁盘 ↔ BUILD-OUTPUTS.json」的差异判定：
 * 登记表是真源，路径清单不需要写死在代码里。
 *
 * 判定逻辑全在纯叶子 scripts/lib/buildRootGuard.js；本文件只负责走盘、读表、打印。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const guard = require('../lib/buildRootGuard');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_ABS = path.join(ROOT, guard.REGISTRY_REL);

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const strict = argv.includes('--strict');
const auditClean = argv.includes('--audit-clean');
const listIds = new Set(
  argv
    .filter((a) => a.startsWith('--list='))
    .flatMap((a) => a.slice('--list='.length).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
);

/** 读登记表。缺失不算失败——步骤 1 之前它本来就不存在；但要在输出里说清楚。 */
function readRegistry() {
  try {
    return { registry: JSON.parse(fs.readFileSync(REGISTRY_ABS, 'utf8')), missing: false };
  } catch {
    return { registry: { meta: { root: guard.BUILD_ROOT }, outputs: [] }, missing: true };
  }
}

/**
 * 走盘，收集「产物候选目录」。
 *
 * 命中 ARTIFACT_DIR_NAMES 即**不再深入**：一个产物目录内部的结构不是本规则的管辖对象，
 * 继续递归只会把 `entries/a/b/c` 这类深层目录全报成 unregistered，那是噪声不是发现。
 */
function scanDisk() {
  const found = [];
  const walk = (dir, rel, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (guard.SKIP_TOP.includes(childRel.split('/')[0])) continue;
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.git-backup')) continue;
      if (
        guard.ARTIFACT_DIR_NAMES.includes(e.name) ||
        /\.egg-info$/.test(e.name) ||
        childRel === guard.BUILD_ROOT
      ) {
        found.push(childRel);
        continue;
      }
      walk(path.join(dir, e.name), childRel, depth + 1);
    }
  };
  walk(ROOT, '', 0);
  // 寄生产物目录名（vendor / egg-info / 工具强制 _build）不在 ARTIFACT_DIR_NAMES 里，
  // 走盘扫不到，必须按登记清单显式探一次 —— 否则棘轮没有输入。
  for (const p of Object.keys(guard.DEFAULT_PARASITIC)) {
    if (fs.existsSync(path.join(ROOT, p))) found.push(p);
  }
  return [...new Set(found)].sort();
}

/**
 * 体检 scripts/maintenance/clean.js 的清理登记表。
 *
 * 「随时能删」不是一句承诺，而是一条可自动判定的不变量：clean 登记表必须覆盖
 * 磁盘上全部产物目录。本函数只做一件事——把「磁盘上真实存在、但 clean 管不到」
 * 的路径列出来。实测 2026-09-16 为 17 条。
 */
function auditCleanRegistry() {
  const src = path.join(ROOT, 'scripts', 'maintenance', 'clean.js');
  let rels = [];
  try {
    rels = [...fs.readFileSync(src, 'utf8').matchAll(/rel:\s*'([^']+)'/g)].map((m) => m[1]);
  } catch {
    return { declared: 0, covered: 0, gaps: [], disk: [] };
  }
  const disk = scanDisk();
  const gaps = disk.filter(
    (p) =>
      p !== guard.BUILD_ROOT &&
      !guard.SOURCE_DIR_ALLOWLIST.includes(p) &&
      !rels.some((r) => p === r || p.startsWith(r + '/') || r.startsWith(p + '/'))
  );
  return { declared: rels.length, covered: disk.length - gaps.length, gaps, disk };
}

function main() {
  if (auditClean) {
    const a = auditCleanRegistry();
    if (asJson) {
      console.log(JSON.stringify(a, null, 2));
    } else {
      console.log('── clean.js 清理登记表体检（I1 可删除性）');
      console.log(`  声明条目：${a.declared} 条`);
      console.log(`  磁盘产物候选：${a.disk.length} 个`);
      console.log(`  其中被登记覆盖：${a.covered} 个`);
      console.log(`  登记管不到的：${a.gaps.length} 个`);
      console.log('');
      for (const g of a.gaps) console.log(`  [GAP] ${g}`);
      console.log('');
      console.log(`  Summary: ${a.gaps.length} gap(s).（判据：gap 必须为 0）`);
    }
    process.exit(strict && a.gaps.length ? 1 : 0);
  }

  const { registry, missing } = readRegistry();
  const disk = scanDisk();
  const today = new Date().toISOString().slice(0, 10);

  const scanned = guard.inspect(disk, registry, { today });
  const table = guard.inspectRegistry(registry);
  const findings = [...scanned.findings, ...table.findings];

  if (listIds.size > 0) {
    for (const id of listIds) {
      const hit = findings.filter((f) => f.id === id);
      console.log(`── ${id}（${hit.length} 条）`);
      for (const f of hit) console.log(`  ${f.path}`);
      console.log('');
    }
  }

  const { errors, warnings } = guard.summarize(findings);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          mode: strict ? 'strict' : 'advisory',
          registry: { path: guard.REGISTRY_REL, present: !missing, outputs: (registry.outputs || []).length },
          scanned: scanned.checked,
          findings,
          summary: { errors, warnings },
        },
        null,
        2
      )
    );
  } else {
    console.log(`check-build-root — 规则 LAYOUT-005 / 真源 docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] 构建产物单一根规范.md`);
    console.log(
      `模式：${strict ? 'strict（有 error 即 exit 1）' : 'advisory（只报不改，恒 exit 0）'}` +
        `　产物根：${guard.BUILD_ROOT}/　登记表：${guard.REGISTRY_REL}` +
        `${missing ? '（缺失，按空表判定）' : `（${(registry.outputs || []).length} 条）`}`
    );
    console.log('');
    console.log(guard.render({ findings }, `扫描 ${scanned.checked} 个产物候选目录`));
    console.log('');
    if (missing) {
      console.log('提示：登记表尚未建立。步骤 1「标记」须先落 docs/10_规范/registry/BUILD-OUTPUTS.json。');
      console.log('');
    }
    if (errors > 0 && !strict) {
      console.log(`提示：当前 ${errors} 条 error 属存量，advisory 模式下不阻断。`);
      console.log('      迁移顺序见 [DESIGN-LAY-004] §8 三步接线清单与 §9 映射表。');
      console.log('');
    }
    console.log('复现与反例矩阵：node "docs/10_规范/DESIGN-LAY/[DESIGN-LAY-004] build-root-demo.js" --all');
  }

  process.exit(strict && errors > 0 ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { scanDisk, auditCleanRegistry, readRegistry };
