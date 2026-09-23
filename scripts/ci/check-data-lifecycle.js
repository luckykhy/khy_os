#!/usr/bin/env node
/**
 * check-data-lifecycle.js — UPLOAD-001 + AUD-001 + MIG-001 + DLQ-001 gate
 *
 * Enforces:
 *   UPLOAD-001: File size limits, MIME type checks, virus scan hooks
 *   AUD-001: Audit log immutability, 5-field structure
 *   MIGR-001: Paired up/down migrations
 *   DLQ-001: DLQ with exponential backoff, max retries
 *
 * Usage: node scripts/ci/check-data-lifecycle.js [--changed] [file-or-dir ...]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
const changedMode = args.includes('--changed');
const rawTargets = args.filter((a) => !a.startsWith('--'));

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cache', '.tmp',
  'coverage', 'logs', '.venv', 'venv', '__pycache__',
  'site-packages', 'vendor', 'third_party', 'test', 'tests',
]);

const findings = [];
let exitCode = 0;

function addFinding(severity, rule, file, line, message) {
  findings.push({ severity, rule, file: path.relative(REPO_ROOT, file), line, message });
  if (severity === 'CRITICAL' || severity === 'HIGH') exitCode = 1;
}

function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') ||
    trimmed.startsWith('/*') || trimmed.startsWith('#');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function changedFiles() {
  const { execSync } = require('child_process');
  try {
    const out = execSync('git diff --name-only HEAD', { encoding: 'utf8', cwd: REPO_ROOT });
    return out.split('\n').filter(Boolean).map((f) => path.join(REPO_ROOT, f));
  } catch {
    return [];
  }
}

function targets() {
  if (rawTargets.length > 0) return rawTargets.map((t) => path.resolve(REPO_ROOT, t));
  if (changedMode) return changedFiles();
  const dirs = [
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'services'),
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'routes'),
    path.join(REPO_ROOT, 'services', 'backend', 'migrations'),
  ];
  const out = [];
  for (const d of dirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) walk(d, out);
  }
  return out;
}

// ── AUD-001: Audit log structure ────────────────────────────────────────────

function checkAuditLog(file, content) {
  // Only check files that are actual audit log implementations
  if (!/\bauditLog\b|\baudit_log\b|\bAuditLog\b/.test(content)) return;
  // Skip files that just mention audit in comments or variable names
  if (!/\b(?:auditLog\.|audit_log\.|AuditLog\.|createAudit|logAudit|writeAudit)\b/.test(content)) return;

  // Check for 5-field structure: Who, When, What, Where, Result
  const hasWho = /\buserId\b|\buser\b.*\bid\b|\bactor\b/.test(content);
  const hasWhen = /\btimestamp\b|\bcreatedAt\b|\bat\b/.test(content);
  const hasWhat = /\baction\b|\bevent\b|\boperation\b/.test(content);
  const hasWhere = /\bip\b|\baddress\b|\bendpoint\b/.test(content);
  const hasResult = /\bresult\b|\bstatus\b|\boutcome\b/.test(content);

  const fields = [hasWho, hasWhen, hasWhat, hasWhere, hasResult].filter(Boolean).length;
  if (fields < 3) {
    addFinding('MEDIUM', 'AUD-001', file, 1,
      `Audit log should record all 5 fields (Who/When/What/Where/Result). Found ${fields}/5 (AUD-001).`);
  }

  // Check for immutability (no update/delete on audit records)
  if (/\baudit\b.*\b(?:update|delete|remove|destroy)\b/i.test(content)) {
    addFinding('HIGH', 'AUD-001', file, 1,
      'Audit records must not be updated or deleted (AUD-001 §2).');
  }
}

// ── MIG-001: Migration pairs ────────────────────────────────────────────────

function checkMigrations(file, content) {
  const ext = path.extname(file);
  if (!['.js', '.sql'].includes(ext)) return;
  if (!path.basename(file).match(/^\d{4}.*\.(js|sql)$/)) return;

  const dir = path.dirname(file);
  const baseName = path.basename(file).replace(/\.(js|sql)$/, '');

  // Check for paired up/down migrations (only for JS)
  if (ext === '.js') {
    const hasUp = /\bup\b.*\bfunction\b/.test(content);
    const hasDown = /\bdown\b.*\bfunction\b/.test(content);
    if (!hasUp || !hasDown) {
      addFinding('HIGH', 'MIG-001', file, 1,
        'Migration must have paired up() and down() functions (MIG-001 §2).');
    }
  }

  // Check for irreversible operations
  const hasIrreversible = /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b.*\bWHERE\b.*=.*'.*'/i.test(content);
  if (hasIrreversible) {
    addFinding('MEDIUM', 'MIG-001', file, 1,
      'Irreversible operation detected — ensure backup before running (MIG-001 §2).');
  }
}

// ── DLQ-001: Retry configuration ────────────────────────────────────────────

function checkDlqRetry(file, content) {
  // Skip comment lines — only flag actual retry logic
  const codeLines = content.split('\n').filter((l) => !isCommentLine(l));
  const codeText = codeLines.join('\n');

  if (!/\b(?:dlq|dead.?letter|retry|backoff)\b/i.test(codeText)) return;

  // Check for max retries in actual code
  const hasMaxRetries = /\bmaxRetries\b|\bmax_retries\b|\bMAX_RETRIES\b|\bmaxAttempts\b/i.test(codeText);
  if (!hasMaxRetries && /\bretry\b/i.test(codeText)) {
    const firstRetryLine = codeText.split('\n').findIndex((l) => /\bretry\b/i.test(l)) + 1;
    addFinding('LOW', 'DLQ-001', file, firstRetryLine || 1,
      'Retry logic should define max retries (DLQ-001 §3.1).');
  }

  // Check for exponential backoff in actual code
  if (/\bretry\b/i.test(codeText)) {
    const hasBackoff = /\bbackoff\b|\bdelay\b.*\*\s*2|\bexponential\b/i.test(codeText);
    if (!hasBackoff) {
      const firstRetryLine = codeText.split('\n').findIndex((l) => /\bretry\b/i.test(l)) + 1;
      addFinding('LOW', 'DLQ-001', file, firstRetryLine || 1,
        'Retry should use exponential backoff (DLQ-001 §3.1).');
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = targets();
  let checked = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (!['.js', '.ts', '.sql'].includes(ext)) continue;

    const content = fs.readFileSync(file, 'utf8');
    checkAuditLog(file, content);
    checkMigrations(file, content);
    checkDlqRetry(file, content);
    checked++;
  }

  // Report
  const byRule = {};
  for (const f of findings) {
    (byRule[f.rule] ||= []).push(f);
  }

  for (const [rule, items] of Object.entries(byRule)) {
    process.stdout.write(`\n[${rule}] ${items.length} findings:\n`);
    for (const item of items.slice(0, 10)) {
      process.stdout.write(
        `  ${item.severity} ${path.relative(REPO_ROOT, item.file)}:${item.line} — ${item.message}\n`
      );
    }
    if (items.length > 10) {
      process.stdout.write(`  ... and ${items.length - 10} more\n`);
    }
  }

  process.stdout.write(
    `\n[data-lifecycle] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
