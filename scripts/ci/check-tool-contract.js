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

const guard = require('../lib/toolContractGuard');
const descGuard = require('../lib/toolDescriptionGuard');

// Registry-global findings have no per-tool file; fall back to the registry module.
const REGISTRY_REL = 'services/backend/src/tools/index.js';
// Cap on per-rule warning details printed for the description audit — the
// ~130 not-yet-rewritten legacy tools produce a large warning backlog, so the
// full list would drown the signal. Counts stay exact; details are sampled.
const DESC_WARN_DETAILS_PER_RULE = 5;

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

// Load the live registry tools for the description audit (the pure leaf takes
// an array; this shell does all the IO/require). Returns null on load failure.
function loadRegistryTools() {
  try {
    const registry = require('../../services/backend/src/tools');
    const map = registry.getAll();
    if (map && typeof map.values === 'function') return Array.from(map.values());
    if (Array.isArray(map)) return map;
    return [];
  } catch {
    return null;
  }
}

// Description-audit reporting: errors are printed in full (they block);
// warnings are summarized per rule (count + first N details) to keep the
// output readable while the legacy backlog is being rewritten.
function printDescriptionFindings(result) {
  const errors = result.findings.filter((f) => f.severity === 'error');
  const warnings = result.findings.filter((f) => f.severity === 'warning');

  for (const f of errors) {
    console.log(`[ERROR] desc-${f.rule === 'guard' ? 'guard' : f.rule} ${REGISTRY_REL}:0`);
    console.log(`  ${f.tool}: ${f.message}`);
  }

  if (warnings.length > 0) {
    const byRule = new Map();
    for (const f of warnings) {
      if (!byRule.has(f.rule)) byRule.set(f.rule, []);
      byRule.get(f.rule).push(f);
    }
    console.log(`Description-audit warnings: ${warnings.length} total across ${byRule.size} rule(s) (non-blocking):`);
    for (const rule of Array.from(byRule.keys()).sort()) {
      const list = byRule.get(rule);
      console.log(`  [WARN ] ${rule}: ${list.length} tool-finding(s)`);
      for (const f of list.slice(0, DESC_WARN_DETAILS_PER_RULE)) {
        console.log(`    - ${f.tool}: ${f.message}`);
      }
      if (list.length > DESC_WARN_DETAILS_PER_RULE) {
        console.log(`    ... and ${list.length - DESC_WARN_DETAILS_PER_RULE} more (run the description guard on the registry for the full list)`);
      }
    }
  }

  console.log(`Description-audit summary: ${result.total} tool(s), ${errors.length} error(s), ${warnings.length} warning(s).`);
  return { errors: errors.length, warnings: warnings.length };
}

// Run the description-quality audit over the live registry. Returns the
// error count (errors block; warnings never do — see note below).
function runDescriptionAudit() {
  const tools = loadRegistryTools();
  if (tools === null) {
    console.log(`[ERROR] desc-guard ${REGISTRY_REL}:0`);
    console.log('  Failed to load the tool registry for the description audit.');
    return 1;
  }
  const result = descGuard.assessTools(tools);
  if (result.findings.length === 0) {
    console.log(`Description-quality audit passed: ${result.total} tool(s), no findings.`);
    return 0;
  }
  console.log(`\nDescription-quality audit over ${result.total} tool(s):`);
  const { errors } = printDescriptionFindings(result);
  return errors;
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
  } else {
    console.log(`Tool-contract audit over ${total} tool(s):`);
    printFindings(findings);
  }

  // Description-quality audit (toolDescriptionGuard). Blocking policy:
  // description ERRORS block; description WARNINGS never flip the exit code —
  // not even under --strict-warnings — because ~93 legacy findings predate the
  // guideline rewrite. TODO: fold description warnings into --strict-warnings
  // once the legacy backlog (desc-overlong / enum-example-missing /
  // param-naming-mixed) is cleared.
  const descErrors = runDescriptionAudit();

  const hasError = errors > 0 || descErrors > 0;
  const hasWarn = warnings > 0;
  if (hasError || (strictWarnings && hasWarn)) {
    process.exit(1);
  }
}

main();
