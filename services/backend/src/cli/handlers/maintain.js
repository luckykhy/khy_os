'use strict';

/**
 * maintain handler — `khy maintain`（单人维护者健康驾驶舱）
 *
 *   khy maintain               运行驾驶舱：一条命令看全仓可维护性健康 + 唯一下一步
 *   khy maintain status        同上（别名 health / doctor）
 *   khy maintain audit         展开「基建裸奔」明细（改动文件的公共面缺口）
 *
 * 注意：`khy maintain gen|refresh|check|show|link|hook` 仍是 `.ai/` 元数据子命令，
 * 由 metadata handler 处理（见 router 分流）。本 handler 只负责聚合驾驶舱与审计明细。
 *
 * 设计：确定性地板（零网络零模型）、fail-soft、只读。red 裁决以非零退出，
 * 供单人维护者把 `khy maintain` 当作提交前/升级前的 CI 自检门禁。
 */

const path = require('path');

function fmt() {
  return require('../formatters');
}

/** 按状态选 formatter（formatter 自带 ✓/⚠/✗/ℹ 前缀，避免重复图标）。 */
function _printByStatus(status, line, f) {
  if (status === 'green') return f.printSuccess(line);
  if (status === 'yellow') return f.printWarn(line);
  if (status === 'red') return f.printError(line);
  return f.printInfo(line);
}

function _levelLabel(level) {
  switch (level) {
    case 'green': return '健康';
    case 'yellow': return '有待办';
    case 'red': return '需处理';
    default: return '未知';
  }
}

async function handleMaintain(parsed = {}) {
  const { printInfo, printSuccess, printError, printWarn } = fmt();
  const rawArgs = Array.isArray(parsed.args) ? parsed.args.slice() : [];
  const sub = String(parsed.subCommand || rawArgs[0] || '').toLowerCase();

  const cockpit = require('../../services/maintainerCockpit');

  if (sub === 'audit') {
    return _renderAudit(cockpit, { printInfo, printSuccess, printWarn });
  }

  if (sub === 'freshness') {
    return _renderFreshness(cockpit, parsed, { printInfo, printSuccess, printError, printWarn });
  }

  // 默认 / status / health / doctor → 驾驶舱总览
  const report = cockpit.runCockpit();

  printInfo(`维护者驾驶舱 · ${report.root}`);
  printInfo('─'.repeat(48));
  const f = { printInfo, printSuccess, printError, printWarn };
  for (const c of report.checks) {
    _printByStatus(c.status, `${c.label}：${c.detail}`, f);
  }
  printInfo('─'.repeat(48));

  _printByStatus(report.level, `总体：${_levelLabel(report.level)}`, f);

  if (report.nextAction) {
    printInfo(`下一步：${report.nextAction}`);
  } else {
    printInfo('下一步：无——保持现状即可。');
  }

  // red → 非零退出（提交前/升级前 CI 自检门禁）。
  if (report.level === 'red') process.exitCode = 1;
  return true;
}

/** `khy maintain audit`：展开改动文件的基建裸奔明细。 */
function _renderAudit(cockpit, { printInfo, printSuccess, printWarn }) {
  const root = cockpit._findRepoRoot();
  let changed = [];
  try { changed = cockpit._gitChangedJsFiles(root); } catch { changed = []; }
  if (!changed.length) {
    printSuccess('无改动的后端 JS 文件，无需审计。');
    return true;
  }
  const fs = require('fs');
  const { SelfSustainingInfra } = require('../../services/selfSustainingInfra');
  const fileMap = {};
  for (const rel of changed) {
    try { fileMap[rel] = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { /* skip */ }
  }
  const { gaps, byKind } = new SelfSustainingInfra().audit(fileMap);
  const focus = (gaps || []).filter(g => g && g.kind !== 'missing-test');
  printInfo(`基建裸奔审计 · ${Object.keys(fileMap).length} 个改动文件`);
  printInfo('─'.repeat(48));
  if (!focus.length) {
    printSuccess('改动文件的公共面完备（无缺契约/裸 any/隐式依赖）。');
  } else {
    for (const g of focus) {
      printWarn(`  ⚠ [${g.kind}] ${g.file}${g.symbol ? ` · ${g.symbol}` : ''} — ${g.detail || ''}`);
    }
    printInfo('─'.repeat(48));
    const summary = Object.entries(byKind || {}).filter(([k]) => k !== 'missing-test').map(([k, v]) => `${k} ${v}`).join('、');
    printInfo(`合计：${focus.length} 处（${summary}）。这些仅为建议——补齐契约/类型/依赖声明可让简单模型更安全地维护。`);
  }
  return true;
}

/**
 * `khy maintain freshness`：与时俱进体检（运行时保期 / 模型时效 / 自维护设施 / 守卫覆盖）。
 * 本 handler 负责 IO 探测（版本、文件存在性、package.json 脚本串），把事实交给纯叶子
 * futureProofing.buildFreshnessReport 做确定性判级；red → 非零退出可作升级前门禁。
 */
function _renderFreshness(cockpit, parsed, f) {
  const { printInfo } = f;
  const fp = require('../../services/futureProofing');
  const fs = require('fs');
  const root = cockpit._findRepoRoot();

  // 运行时版本（确定性事实，传入叶子）。
  const nodeVersion = (typeof process !== 'undefined' && process.version) || '';

  // 当前钉选的首选模型（单一真源）。
  let primaryModels = {};
  try { primaryModels = require('../../constants/models').PRIMARY || {}; } catch { primaryModels = {}; }

  // 自维护设施支柱：探测文件/目录存在性。
  const _exists = (rel) => { try { return fs.existsSync(path.join(root, rel)); } catch { return false; } };
  const wiring = {
    pipLifeline: _exists('setup.py'),
    aiSeedDocs: _exists('.ai/GUARDS.md') || _exists('.ai/MAP.md'),
    maintenanceLaunchers: _exists('maintenance'),
    inheritanceDoc: _exists('docs/传承'),
  };

  // 守卫接线：解析 package.json 的 check:small-model:safety 脚本串。
  const guards = _detectGuards(fs, path, root);

  const now = new Date();
  const report = fp.buildFreshnessReport({ now, nodeVersion, primaryModels, wiring, guards });

  if (parsed && (parsed.json || parsed.options?.json)) {
    printInfo(JSON.stringify({ generatedAt: now.toISOString(), ...report }, null, 2));
    if (report.level === 'red') process.exitCode = 1;
    return true;
  }

  printInfo(`与时俱进体检 · ${root}`);
  printInfo('─'.repeat(48));
  for (const c of report.checks) {
    _printByStatus(c.status, `${c.label}：${c.detail}`, f);
    if (c.action) printInfo(`    → ${c.action}`);
  }
  printInfo('─'.repeat(48));
  _printByStatus(report.level, `总体：${report.summary}`, f);

  if (report.level === 'red') process.exitCode = 1;
  return true;
}

/** 从 package.json 解析哪些机器守卫已串入提交门禁链。fail-soft 返回 {}。 */
function _detectGuards(fs, pathMod, root) {
  const expected = ['check-agent-rules', 'check-leaf-contract', 'check-model-hardcoding', 'check-change-safety'];
  const out = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pathMod.join(root, 'package.json'), 'utf8'));
    const scripts = (pkg && pkg.scripts) || {};
    const blob = Object.values(scripts).join('\n');
    for (const g of expected) out[g] = blob.includes(g);
  } catch {
    return {};
  }
  return out;
}

module.exports = { handleMaintain };
