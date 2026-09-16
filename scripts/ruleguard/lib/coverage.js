'use strict';

const { loadBinding } = require('./registry');
const { buildManifest } = require('./manifest');
const ledger = require('./ledger');
const { scanExternalRules } = require('./externalRules');

/**
 * coverage.js — "how much of the rule set is actually being enforced?".
 *
 * The report answers five questions in one pass:
 *   1. how many rules have a machine executor at all
 *   2. how many of those are actually wired into a gate
 *   3. how many checkers exist but are wired nowhere (orphans)
 *   4. how many P0 rules are unenforced (the hard red line)
 *   5. how many rules a checker enforces that the registry never recorded
 *      (the coverage denominator is registry-only, so these are invisible
 *       unless this report says so)
 *
 * Exits non-zero only on the blocking red lines; soft indicators are printed
 * for trend tracking, never gate failures.
 */

const BLOCKING_CODES = {
  'p0-unenforced': 'P0 规则处于 unenforced 状态：最高优先级的规则必须有机器执行器。',
  'enforced-uwired': '规则声明的执行器存在但未挂到任何门：声明已失效。',
  'dead-pointer': '规则的执行器路径不存在：登记表指向死指针。',
};

function buildCoverage(repoRoot) {
  const { registry, wiring } = loadBinding(repoRoot);
  const manifest = buildManifest(registry, wiring);

  const byKind = manifest.summary.byKind;
  const enforced = (byKind.enforced || 0);
  const total = manifest.summary.total;

  const checkerBasename = (rel) => String(rel).replace(/.*\//, '');

  // Orphan = referenced by NO gate surface at all. Distinct from
  // "unregistered" = wired to a gate but claimed by no registry rule; both
  // matter, but only orphans mean a checker can never run.
  const orphans = wiring.checkerFiles.filter((file) => !(wiring.references[file] || []).length);

  const registryExecuted = new Set(
    manifest.rules.filter((rule) => rule.script).map((rule) => checkerBasename(rule.script)),
  );
  const unregisteredCheckers = wiring.checkerFiles.filter(
    (file) => !registryExecuted.has(file) && (wiring.references[file] || []).length,
  );

  // 覆盖率的分母只有登记表里的规则，所以检查器自述的「登记表外规则 ID」是这条
  // 报告刻意补上的第五问：哪些规则真在生效、但登记表从未收录。
  const external = scanExternalRules(repoRoot, new Set(manifest.rules.map((r) => r.id)));

  const redLines = [];
  for (const rule of manifest.rules) {
    if (rule.priority === 'P0' && rule.kind === 'unenforced') {
      redLines.push({ code: 'p0-unenforced', rule: rule.id, message: BLOCKING_CODES['p0-unenforced'] });
    }
    if (rule.kind === 'dead-pointer') {
      redLines.push({ code: 'dead-pointer', rule: rule.id, script: rule.script, message: BLOCKING_CODES['dead-pointer'] });
    }
    if (rule.priority === 'P0' && rule.kind === 'declared-uwired') {
      redLines.push({ code: 'enforced-uwired', rule: rule.id, script: rule.script, message: BLOCKING_CODES['enforced-uwired'] });
    }
  }

  return {
    registry: { file: registry.rel, meta: registry.meta, errors: registry.errors },
    summary: manifest.summary,
    enforced,
    total,
    rate: total ? Number((enforced / total * 100).toFixed(1)) : 0,
    byKind,
    byGate: manifest.summary.byGate,
    byPriority: countBy(manifest.rules, 'priority'),
    checkers: {
      total: wiring.checkerFiles.length,
      referenced: wiring.checkerFiles.length - orphans.length,
      orphans,
      unregisteredCheckers,
    },
    unenforced: manifest.rules.filter((rule) => rule.kind === 'unenforced')
      .map((rule) => ({ id: rule.id, priority: rule.priority, name: rule.name, owner: rule.owner })),
    externalRules: {
      count: external.externalIds.length,
      checkers: external.checkers.filter((c) => c.externalIds.length).length,
      ids: external.externalIds,
      codeFamilies: external.codeFamilies,
    },
    declaredUwired: manifest.rules.filter((rule) => rule.kind === 'declared-uwired')
      .map((rule) => ({ id: rule.id, script: rule.script })),
    deadPointers: manifest.rules.filter((rule) => rule.kind === 'dead-pointer')
      .map((rule) => ({ id: rule.id, script: rule.script })),
    manual: manifest.rules.filter((rule) => rule.kind === 'manual')
      .map((rule) => ({ id: rule.id, name: rule.name })),
    carriers: manifest.rules.filter((rule) => rule.kind === 'carrier')
      .map((rule) => ({ id: rule.id, name: rule.name, carriers: rule.carriers })),
    activeSuppressions: ledger.activeSuppressions(repoRoot),
    redLines,
    rules: manifest.rules,
  };
}

function countBy(items, field) {
  const out = {};
  for (const item of items) out[item[field]] = (out[item[field]] || 0) + 1;
  return out;
}

/** Human-readable coverage report. `ci` adds the blocking red-line verdict. */
function renderCoverage(coverage, { ci = false } = {}) {
  const lines = [];
  lines.push('规则遵守覆盖率（ruleguard）');
  lines.push(`登记表：${coverage.registry.file}  规则 ${coverage.total} 条`);
  lines.push(`已执行 ${coverage.enforced} 条（${coverage.rate}%）`);
  lines.push('');
  lines.push('按归类：');
  for (const [kind, count] of Object.entries(coverage.byKind)) {
    lines.push(`  ${kind.padEnd(16)} ${String(count).padStart(3)}`);
  }
  lines.push('');
  lines.push('按优先级：');
  for (const [priority, count] of Object.entries(coverage.byPriority)) {
    lines.push(`  ${priority.padEnd(6)} ${String(count).padStart(3)}`);
  }
  lines.push('');
  lines.push(`检查器：${coverage.checkers.referenced}/${coverage.checkers.total} 已接线`);

  if (coverage.checkers.orphans.length) {
    lines.push(`  零接线（${coverage.checkers.orphans.length}）：${coverage.checkers.orphans.join(', ')}`);
  }
  if (coverage.checkers.unregisteredCheckers.length) {
    lines.push(`  未被任何规则登记（${coverage.checkers.unregisteredCheckers.length}）：${coverage.checkers.unregisteredCheckers.join(', ')}`);
  }

  if (coverage.deadPointers.length) {
    lines.push('');
    lines.push('死指针：');
    for (const item of coverage.deadPointers) lines.push(`  ${item.id} -> ${item.script}`);
  }
  if (coverage.declaredUwired.length) {
    lines.push('');
    lines.push('已声明但未接线：');
    for (const item of coverage.declaredUwired) lines.push(`  ${item.id} -> ${item.script}`);
  }
  if (coverage.unenforced.length) {
    lines.push('');
    lines.push(`未挂载执行器（${coverage.unenforced.length}）：`);
    for (const item of coverage.unenforced) {
      lines.push(`  ${item.id.padEnd(14)} ${item.priority} ${item.name}`);
    }
  }
  if (coverage.manual.length) {
    lines.push('');
    lines.push(`人工评审兜底（${coverage.manual.length}）：${coverage.manual.map((item) => item.id).join(', ')}`);
  }
  if (coverage.carriers.length) {
    lines.push('');
    lines.push(`运行时代码承载、无检查器（${coverage.carriers.length}）：`);
    for (const item of coverage.carriers) {
      lines.push(`  ${item.id.padEnd(14)} ${item.name} -> ${item.carriers.join(', ')}`);
    }
  }

  // 覆盖率盲区：检查器在执行、登记表从未收录的规则。advisory——这些规则是真在
  // 生效，缺的是登记，不是执行，故 --ci 下也不阻断。
  const external = coverage.externalRules;
  if (external && external.count) {
    lines.push('');
    lines.push(
      `覆盖率盲区 — 检查器在执行但登记表未收录的规则（${external.count} 个 ID，`
      + `分布在 ${external.checkers} 个检查器）：`
    );
    for (const item of external.ids) {
      lines.push(`  ${item.id.padEnd(14)} ${item.checkers.join(', ')}`);
    }
    if (external.codeFamilies.length) {
      lines.push(
        `  （已排除 ${external.codeFamilies.length} 个内部编码族：`
        + `${external.codeFamilies.join(' ')}——形状同形但不是规则）`
      );
    }
    lines.push('  → 不计入上面的覆盖率分母；`--ci` 不阻断，需人工裁决是否补登。');
  }
  const suppressions = Object.entries(coverage.activeSuppressions);
  if (suppressions.length) {
    lines.push('');
    lines.push(`活跃抑制（台账累计 ${suppressions.length} 类）：`);
    for (const [ruleId, count] of suppressions) lines.push(`  ${ruleId}: ${count} 次`);
  }

  if (coverage.redLines.length) {
    lines.push('');
    lines.push(`阻断红线命中 ${coverage.redLines.length} 条：`);
    for (const line of coverage.redLines) lines.push(`  [ERROR] ${line.rule || line.code} ${line.message}`);
  } else if (ci) {
    lines.push('');
    lines.push('阻断红线：全部通过');
  }

  if (coverage.registry.errors.length) {
    lines.push('');
    lines.push(`登记表结构问题 ${coverage.registry.errors.length} 条：`);
    for (const error of coverage.registry.errors) lines.push(`  [ERROR] ${error.message}`);
  }

  return lines.join('\n');
}

/** Coverage exit code: red lines and registry errors block, soft metrics do not. */
function coverageCode(coverage) {
  if (coverage.redLines.length) return 1;
  if (coverage.registry.errors.length) return 1;
  return 0;
}

module.exports = { buildCoverage, renderCoverage, coverageCode, BLOCKING_CODES };
