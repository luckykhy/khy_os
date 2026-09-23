#!/usr/bin/env node
/**
 * Model-list-truth wiring checker (machine-enforced truth-chokepoint discipline).
 *
 * Runs changed (or explicitly passed) files through the pure `assessFile` guard in
 * scripts/lib/modelListTruthGuard.js. Any surface that bypasses `aiGateway.listModels()`
 * — the single chokepoint where the adapter's candidate pool is converged into a
 * truth table — and instead calls an adapter's `.listModels()` directly gets caught at
 * commit time, so "show the user a model that 404s on first call" cannot quietly come
 * back through a new code path.
 *
 * See docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-100] 模型列表真值校验与过滤规范.md
 *
 * Usage:
 *   node scripts/check-model-list-truth.js --changed
 *   node scripts/check-model-list-truth.js --changed --strict-warnings
 *   node scripts/check-model-list-truth.js <file-or-dir> [more...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const guard = require('../lib/modelListTruthGuard');

const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const changedMode = args.includes('--changed');
const rawTargets = args.filter((a) => !a.startsWith('--'));

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cache', '.tmp', 'coverage', 'logs',
  'bundled', '_source',
]);

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

function shouldIgnore(filePath) {
  return String(filePath).split(path.sep).some((p) => IGNORE_DIRS.has(p));
}

function collectFilesFromTarget(targetPath, out) {
  const full = path.resolve(cwd, targetPath);
  if (!fs.existsSync(full)) return;
  const st = fs.statSync(full);
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(full)) {
      collectFilesFromTarget(path.join(targetPath, entry), out);
    }
    return;
  }
  const rel = path.relative(cwd, full);
  if (shouldIgnore(rel)) return;
  if (!guard.LEAF_RULE_EXTS.has(guard.fileExt(rel))) return;
  out.add(rel.replace(/\\/g, '/'));
}

// 无参调用(npm run check:model-list-truth)的默认扫描面:模型列表接线只在后端源码里。
const DEFAULT_TARGETS = ['services/backend/src'];

function gatherFiles() {
  const out = new Set();
  if (changedMode) {
    for (const rel of listChangedFiles()) collectFilesFromTarget(rel, out);
  }
  const targets = rawTargets.length > 0 ? rawTargets : changedMode ? [] : DEFAULT_TARGETS;
  for (const t of targets) collectFilesFromTarget(t, out);
  return [...out];
}

function main() {
  const files = gatherFiles();
  if (files.length === 0) {
    console.log('No target files found. Use --changed or pass file/directory paths.');
    process.exit(0);
  }
  const findings = [];
  for (const rel of files) {
    let source = '';
    try {
      source = fs.readFileSync(path.resolve(cwd, rel), 'utf8');
    } catch {
      continue;
    }
    const result = guard.assessFile({ relPath: rel, source });
    for (const f of (result && result.findings) || []) {
      findings.push({ ...f, file: rel });
    }
  }

  if (findings.length === 0) {
    console.log('Model-list-truth check passed: no direct adapter listModels() bypass found.');
    process.exit(0);
  }

  for (const f of findings) {
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    console.log(`[${prefix}] ${f.rule} ${f.file}:${f.line}`);
    console.log(`  ${f.message}`);
    if (f.snippet) console.log(`  ${f.snippet}`);
  }
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  console.log(`\nSummary: ${errorCount} error(s), ${warnCount} warning(s).`);

  if (errorCount > 0 || (strictWarnings && warnCount > 0)) {
    process.exit(1);
  }
}

main();
