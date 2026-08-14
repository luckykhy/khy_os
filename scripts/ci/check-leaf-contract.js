#!/usr/bin/env node
/**
 * Pure-leaf contract checker (machine-enforced leaf contract).
 *
 * Reads changed (or explicitly passed) files and runs them through the pure-leaf
 * `assessFile` guard in scripts/lib/leafContractGuard.js. The guard codifies the
 * contract every self-declared 纯叶子 promises in its own docstring (zero IO,
 * env-gated, fail-soft) plus a repo-wide VCS conflict-marker rule, so a weaker
 * model that quietly violates the contract gets caught at commit time instead of
 * at a remote build months later.
 *
 * Usage:
 *   node scripts/check-leaf-contract.js --changed
 *   node scripts/check-leaf-contract.js --changed --strict-warnings
 *   node scripts/check-leaf-contract.js <file-or-dir> [more...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const guard = require('../lib/leafContractGuard');

const cwd = process.cwd();
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const changedMode = args.includes('--changed');
const rawTargets = args.filter((a) => !a.startsWith('--'));

// 文本源:含内核 C/汇编/链接脚本(冲突标记规则覆盖它们),也含 JS/TS/Vue/JSON/MD。
const TEXT_EXTS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.vue',
  '.py', '.json', '.yaml', '.yml', '.md',
  '.c', '.h', '.s', '.asm', '.ld', '.sh',
]);

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cache', '.tmp', 'coverage', 'logs',
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
  const base = path.basename(rel);
  if (!TEXT_EXTS.has(path.extname(rel)) && base !== 'Makefile') return;
  out.add(rel.replace(/\\/g, '/'));
}

function gatherFiles() {
  const out = new Set();
  if (changedMode) {
    for (const rel of listChangedFiles()) collectFilesFromTarget(rel, out);
  }
  for (const t of rawTargets) collectFilesFromTarget(t, out);
  return [...out];
}

function checkFile(relPath, findings) {
  let source = '';
  try {
    source = fs.readFileSync(path.resolve(cwd, relPath), 'utf8');
  } catch {
    return;
  }
  const result = guard.assessFile({ relPath, source });
  for (const f of (result && result.findings) || []) {
    findings.push({ ...f, file: relPath });
  }
}

function printFindings(findings) {
  if (findings.length === 0) {
    console.log('Leaf-contract check passed: no violations found.');
    return;
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
}

function main() {
  const files = gatherFiles();
  if (files.length === 0) {
    console.log('No target files found. Use --changed or pass file/directory paths.');
    process.exit(0);
  }
  const findings = [];
  for (const file of files) checkFile(file, findings);
  printFindings(findings);

  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warning');
  if (hasError || (strictWarnings && hasWarn)) {
    process.exit(1);
  }
}

main();
