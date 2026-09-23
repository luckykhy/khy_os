#!/usr/bin/env node
/**
 * check-notify-webhook.js — NOTIFY-001 gate
 *
 * Enforces:
 *   NOTIFY-001: HMAC signature verification, List-Unsubscribe header,
 *               email HTML+text dual format, webhook retry strategy
 *
 * Usage: node scripts/ci/check-notify-webhook.js [--changed] [file-or-dir ...]
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
  ];
  const out = [];
  for (const d of dirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) walk(d, out);
  }
  return out;
}

// ── NOTIFY-001: Webhook HMAC signature ──────────────────────────────────────

function checkWebhookSignature(file, content) {
  if (!/\bwebhook\b/i.test(content)) return;

  if (/router\.(post|put)\s*\(.*webhook/.test(content) || /\bwebhook\b.*\b(?:handler|endpoint|route)\b/i.test(content)) {
    const hasSignatureCheck = /\b(?:signature|hmac|X-|verifyWebhook)\b/i.test(content);
    if (!hasSignatureCheck) {
      addFinding('HIGH', 'NOTIFY-001', file, 1,
        'Webhook endpoint must verify HMAC signature (NOTIFY-001 §7.3).');
    }

    if (/\b(?:signature|hmac)\b/i.test(content) && !/\btimingSafeEqual\b|\bcrypto\.timingSafeEqual\b/.test(content)) {
      addFinding('MEDIUM', 'NOTIFY-001', file, 1,
        'Webhook signature comparison should use timingSafeEqual (NOTIFY-001 §7.3).');
    }
  }
}

// ── NOTIFY-001: Email dual format ───────────────────────────────────────────

function checkEmailFormat(file, content) {
  if (!/\b(?:email|mail|smtp|nodemailer)\b/i.test(content)) return;

  const hasHtml = /\bhtml\b.*\b(?:render|template|body)\b/i.test(content) || /\btextHtml\b/.test(content);
  const hasText = /\btext\b.*\b(?:plain|version|body)\b/i.test(content) || /\btextPlain\b/.test(content);

  if (hasHtml && !hasText) {
    addFinding('MEDIUM', 'NOTIFY-001', file, 1,
      'Email should have both HTML and plain text versions (NOTIFY-001 §4.3).');
  }
}

// ── NOTIFY-001: List-Unsubscribe header ─────────────────────────────────────

function checkUnsubscribe(file, content) {
  if (!/\b(?:email|mail|smtp)\b/i.test(content)) return;

  const hasUnsubscribe = /List-Unsubscribe/i.test(content);
  if (!hasUnsubscribe && /\bsendMail\b|\btransporter\.sendMail\b|\bnodemailer\b/.test(content)) {
    addFinding('LOW', 'NOTIFY-001', file, 1,
      'Email should include List-Unsubscribe header (NOTIFY-001 §6.2).');
  }
}

// ── NOTIFY-001: Webhook retry strategy ──────────────────────────────────────

function checkWebhookRetry(file, content) {
  if (!/\bwebhook\b/i.test(content)) return;

  const hasRetry = /\bretry\b|\breconnect\b|\bbackoff\b/i.test(content);
  const hasMaxRetries = /\b\w*(?:maxRetries|max_retries|MAX_RETRIES)\b/i.test(content);

  if (hasRetry && !hasMaxRetries) {
    addFinding('LOW', 'NOTIFY-001', file, 1,
      'Webhook should define max retries (NOTIFY-001 §7.4).');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = targets();
  let checked = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (!['.js', '.ts', '.tsx'].includes(ext)) continue;

    const content = fs.readFileSync(file, 'utf8');
    checkWebhookSignature(file, content);
    checkEmailFormat(file, content);
    checkUnsubscribe(file, content);
    checkWebhookRetry(file, content);
    checked++;
  }

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
    `\n[notify-webhook] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
