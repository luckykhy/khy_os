#!/usr/bin/env node
/**
 * Tool-contract checker (machine-enforced tool-registry contract).
 *
 * Unlike per-file guards, tool-contract invariants are REGISTRY-GLOBAL: a name
 * collision or a bad tool schema can only be judged with the whole registry in
 * hand. This guard therefore requires the live tool registry + the pure-leaf
 * auditor (services/backend/src/services/toolCatalog/toolContract.js) and asserts
 * that every registered tool is contract-valid and that no normalized key is
 * claimed by tools of different risk/category (which would make resolution
 * order-dependent — the "小工具不对" precision defect).
 *
 * `--changed`: if none of the changed files touch the tool registry / dedup /
 * resolution modules, the audit is irrelevant → exit 0 without running it. Any
 * relevant change (or no --changed flag) → run the full registry audit.
 *
 * Usage:
 *   node scripts/check-tool-contract.js
 *   node scripts/check-tool-contract.js --changed
 *   node scripts/check-tool-contract.js --changed --strict-warnings
 */
'use strict';

const cp = require('child_process');

const guard = require('./lib/toolContractGuard');

const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const changedMode = args.includes('--changed');

function run(cmd) {
  try {
    return cp.execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function listChangedFiles() {
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (out) return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const staged = run('git diff --name-only --cached --diff-filter=ACMR');
  if (staged) return staged.split('\n').map((s) => s.trim()).filter(Boolean);
  const head = run('git diff --name-only --diff-filter=ACMR HEAD');
  if (head) return head.split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

function printFindings(findings) {
  for (const f of findings) {
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`[${prefix}] ${f.rule} ${f.file}:${f.line}`);
    console.log(`  ${f.message}`);
  }
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s).`);
}

function main() {
  if (changedMode) {
    const changed = listChangedFiles();
    const relevant = changed.some((f) => guard.isRelevantChange(f));
    if (!relevant) {
      console.log('Tool-contract check skipped: no tool-registry changes in this diff.');
      process.exit(0);
    }
  }

  const { findings, errors, warnings, total } = guard.assessRegistry();
  if (findings.length === 0) {
    console.log(`Tool-contract check passed: ${total} tool(s), no violations.`);
    process.exit(0);
  }
  console.log(`Tool-contract audit over ${total} tool(s):`);
  printFindings(findings);

  const hasError = errors > 0;
  const hasWarn = warnings > 0;
  if (hasError || (strictWarnings && hasWarn)) {
    process.exit(1);
  }
}

main();
