'use strict';

const { testPath } = require('./glob');

/**
 * apply.js — "which rules apply to the file I am about to change?".
 *
 * This is the mechanism that makes rules *addressable* rather than prose: an
 * agent or maintainer hands in a path and gets the binding rules with their
 * constraint, exception and benefit, sorted by priority. It reads only the
 * `paths` glob field, so no prose parsing is involved.
 */

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Rules whose `paths` glob matches a repo-relative path. */
function applyToPath(rules, pathname) {
  return rules
    .filter((rule) => rule.globs && rule.globs.positive.length && testPath(pathname, rule.globs))
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
}

/** Rules matching any of several paths, de-duplicated by id. */
function applyToPaths(rules, pathnames) {
  const seen = new Map();
  for (const pathname of pathnames) {
    for (const rule of applyToPath(rules, pathname)) {
      if (!seen.has(rule.id)) seen.set(rule.id, rule);
    }
  }
  return [...seen.values()].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
}

/**
 * Render an applied-rule list for a human or an agent context window.
 * Kept terse on purpose: the rule registry already carries full prose, this
 * is the decision aid, not a second copy.
 */
function renderApplied(rules, pathnames, { verbose = false } = {}) {
  if (!rules.length) {
    return `规则：无匹配（路径 ${pathnames.join(', ')} 未命中任何登记规则的 paths）`;
  }

  const lines = [`路径 ${pathnames.join(', ')} 适用 ${rules.length} 条规则：`];
  for (const rule of rules) {
    const head = `${rule.priority} ${rule.id} ${rule.name}（gate=${rule.gate} / ${rule.kind}）`;
    lines.push(`\n${head}`);
    lines.push(`  约束：${rule.constraint}`);
    if (rule.exception && String(rule.exception).trim()) lines.push(`  例外：${rule.exception}`);
    if (verbose && rule.benefit) lines.push(`  福利：${rule.benefit}`);
    if (verbose && rule.trigger) lines.push(`  触发：${rule.trigger}`);
    if (rule.exec && rule.exec.script) {
      lines.push(`  执行器：node ${rule.exec.script}${rule.exec.args.length ? ' ' + rule.exec.args.join(' ') : ''}`);
    } else if (rule.kind === 'manual') {
      lines.push('  执行器：人工评审兜底');
    } else {
      lines.push('  执行器：无（仅声明，未挂载检查器）');
    }
  }
  return lines.join('\n');
}

module.exports = { applyToPath, applyToPaths, renderApplied, PRIORITY_RANK };
