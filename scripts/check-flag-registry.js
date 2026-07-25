#!/usr/bin/env node
/**
 * KHY_* flag central-registry structural checker (machine-enforced registry integrity).
 *
 * Runs the live flagRegistry table through the pure `assess` guard in
 * scripts/lib/flagRegistryGuard.js. The guard codifies the structural invariants the
 * declarative registry must hold (every `parent` is registered, no parent cycles,
 * valid mode/off/numeric bounds), so a weaker model that quietly breaks the table —
 * a dangling parent, an A→B→A cycle that would blow the resolver's recursion, an
 * illegal mode name — gets caught at commit time instead of at runtime months later.
 *
 * Unlike the other check-* scripts this guard is table-global (it validates the live
 * registry object, not a changed-file set), so it takes no --changed flag. It exits
 * non-zero on any error finding, or on any warning when --strict-warnings is passed.
 *
 * Usage:
 *   node scripts/check-flag-registry.js
 *   node scripts/check-flag-registry.js --strict-warnings
 */
'use strict';

const guard = require('./lib/flagRegistryGuard');

const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');

function printFindings(findings) {
  if (findings.length === 0) {
    console.log('Flag-registry check passed: registry table is structurally sound.');
    return;
  }
  for (const f of findings) {
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`[${prefix}] ${f.rule} ${f.flag}`);
    console.log(`  ${f.message}`);
  }
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s).`);
}

function main() {
  let findings = [];
  try {
    const result = guard.assess({});
    findings = (result && result.findings) || [];
  } catch (e) {
    // 守卫契约是绝不抛;真抛了说明守卫本身坏了 —— 明确失败,别静默放行。
    console.error(`Flag-registry guard threw unexpectedly: ${e && e.message}`);
    process.exit(1);
  }
  printFindings(findings);

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warning');
  if (hasError || (strictWarnings && hasWarn)) {
    process.exit(1);
  }
}

main();
