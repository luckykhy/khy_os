#!/usr/bin/env node
'use strict';

/**
 * discoverability-demo.js — 层级可发现性守卫的反例矩阵。
 *
 * 纪律：**不复制判定逻辑**。全部 require 真源的叶子与 CLI，保证
 * 「原型绿、守卫红」时能立刻分清是规则错了还是原型写歪了。
 *
 * 每个场景打印 `Summary: N error(s), M warning(s).`
 * 含一条 `clean`（应放行）场景，证明不是无脑拦。
 *
 * 用法：node scripts/ci/discoverability-demo.js --all
 *       node scripts/ci/discoverability-demo.js --scenario=flat-overflow
 */

const guard = require('../lib/discoverabilityGuard');

const scenarios = {};
function def(name, fn) { scenarios[name] = fn; }

// 生成 n 个文件条目
function files(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ name: `${prefix || 'mod'}${i}.js`, kind: 'file' });
  return out;
}

def('clean', () => {
  // 一个组织良好的目录：条目数在预算内，且有索引
  const ents = [{ name: '00_INDEX_测试-分类索引.md', kind: 'file' }]
    .concat(files(12, 'item'))
    .concat([{ name: 'sub-a', kind: 'dir' }, { name: 'sub-b', kind: 'dir' }]);
  return guard.inspectDir('docs/12_模板', ents);
});

def('clean-code-dir', () => {
  // 代码目录，条目数在 implementation 档预算内
  return guard.inspectDir('services/backend/src/utils', files(35, 'util'));
});

def('flat-overflow', () => {
  // 经典平铺：809 个文件挤在一个目录
  return guard.inspectDir('services/backend/src/services', files(809, 'service'));
});

def('flat-overflow-boundary-ok', () => {
  // 边界：恰好等于预算（40），应放行
  return guard.inspectDir('services/backend/src/utils', files(40, 'util'));
});

def('flat-overflow-boundary-over', () => {
  // 边界：41 > 40，应拦
  return guard.inspectDir('services/backend/src/utils', files(41, 'util'));
});

def('exempt-vendor', () => {
  // 契约：豁免按**目录自身名**判定，由调用方（CLI）在走盘时跳过。
  // 纯叶子 inspectDir 只看条目，因此「豁免」在叶子层的表现是：调用方根本不喂它。
  // 本场景验证调用方契约 —— isExemptName 必须认 vendor。
  const checks = [
    guard.isExemptName('vendor'),
    guard.isExemptName('node_modules'),
    guard.isExemptName('.cache'),
    guard.isExemptName('dist'),
  ];
  if (checks.every(Boolean) === false) {
    return [{ id: 'exempt-contract-broken', strength: 'error', path: 'vendor',
      detail: 'vendor/node_modules/.cache/dist 应被 isExemptName 认作豁免，实际未全部命中。' }];
  }
  return []; // 契约成立 → 0 发现
});

def('exempt-dotdir', () => {
  // 契约：点目录（.zcode/.cache/.research-tmp…）应被豁免。
  // 实测依据：.zcode/tmp 有 175 条目，若纳入统计就是误报。
  const dotDirs = ['.zcode', '.cache', '.research-tmp', '.claude', '.github'];
  const dots = dotDirs.filter((d) => guard.isDotDir(d));
  const exempt = dotDirs.filter((d) => guard.isExemptName(d));
  if (dots.length !== dotDirs.length || exempt.length !== dotDirs.length) {
    return [{ id: 'dotdir-contract-broken', strength: 'error', path: '.',
      detail: `点目录豁免契约未成立：isDotDir 命中 ${dots.length}/${dotDirs.length}，`
        + `isExemptName 命中 ${exempt.length}/${dotDirs.length}。` }];
  }
  return [];
});

def('docs-budget-stricter', () => {
  // 文档目录预算更严（30）：35 个文件在代码目录合法，在 docs 里超预算
  return guard.inspectDir('docs/11_报告', files(35, 'rpt'));
});

def('no-grouping', () => {
  // 索引有形无实：有标题但一块里平铺 184 条
  let text = '# 00_INDEX 运维分类索引\n\n## 一、分类内容边界\n\n说明文字。\n\n## 二、文件清单\n\n';
  for (let i = 0; i < 184; i += 1) text += `|[OPS-MAN-${i}] 文件${i}.md|职责${i}|在产|\n`;
  text += '\n## 三、跨分类关联指引\n\n无。\n';
  return guard.inspectIndex('docs/07_OPS_运维/00_INDEX_运维-分类索引.md', text);
});

def('index-grouped-ok', () => {
  // 真编组的索引：每块条目数都在预算内
  let text = '# 00_INDEX 示例\n\n';
  for (let g = 0; g < 6; g += 1) {
    text += `## 分组 ${g}\n\n`;
    for (let i = 0; i < 20; i += 1) text += `- item-${g}-${i}.md\n`;
    text += '\n';
  }
  return guard.inspectIndex('docs/99_示例/00_INDEX_示例.md', text);
});

def('empty-index', () => {
  return guard.inspectIndex('docs/99_示例/00_INDEX_示例.md', '');
});

def('robust-nonarray', () => {
  // 健壮性：非数组 / null / 垃圾输入不抛
  return guard.inspectDir('services/backend/src/services', null);
});

def('robust-badentry', () => {
  // 健壮性：条目里有 null / 数字 / 空串，不抛且不误计
  return guard.inspectDir('services/backend/src/services',
    [null, 42, '', { name: 'ok.js', kind: 'file' }].concat(files(45, 'svc')));
});

// ── 运行 ──────────────────────────────────────────────────────────────
const only = (process.argv.find((a) => a.startsWith('--scenario=')) || '').slice(11);
const all = process.argv.includes('--all') || !only;

const names = all ? Object.keys(scenarios) : [only];
let totalErr = 0;
let totalWarn = 0;

for (const name of names) {
  if (!scenarios[name]) {
    console.log(`\n### ${name} —— 未知场景（可用：${Object.keys(scenarios).join(', ')}）`);
    process.exitCode = 2;
    continue;
  }
  let findings;
  try {
    findings = scenarios[name]();
  } catch (err) {
    console.log(`\n### ${name}\n  !! 抛异常（违反「绝不抛」契约）: ${err.message}`);
    process.exitCode = 1;
    continue;
  }
  const s = guard.summarize(findings);
  totalErr += s.errors;
  totalWarn += s.warnings;
  console.log(`\n### ${name}`);
  if (s.total === 0) console.log('  （无发现）');
  for (const f of s.findings) {
    console.log(`  [${f.strength}] ${f.detail}`);
  }
  console.log(`  Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);
}

console.log(`\n═══ 矩阵合计: ${totalErr} error(s), ${totalWarn} warning(s) ═══`);
console.log('说明：clean / clean-code-dir / flat-overflow-boundary-ok / exempt-* / index-grouped-ok');
console.log('      这 6 个场景应为 0 发现（证明守卫不是无脑拦）。');
