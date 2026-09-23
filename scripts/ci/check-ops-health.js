#!/usr/bin/env node
/**
 * check-ops-health.js — OPS-002 + OPS-003 gate
 *
 * Enforces:
 *   OPS-002: Graceful shutdown (SIGTERM handler, drain, close)
 *   OPS-003: Three health endpoints (/health, /ready, /live)
 *
 * Usage: node scripts/ci/check-ops-health.js [--changed] [file-or-dir ...]
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
  return walk(path.join(REPO_ROOT, 'services', 'backend', 'src'));
}

// ── OPS-002: Graceful shutdown ──────────────────────────────────────────────

function checkGracefulShutdown(file, content) {
  // Only check files that actually start an HTTP server
  if (!/\b(?:app\.listen|http\.createServer|https\.createServer)\b/.test(content)) return;

  // Check for SIGTERM handler
  const hasSigterm = /\bprocess\.on\s*\(\s*['"`]SIGTERM['"`]/.test(content);
  const hasShutdown = /\bshutdown\b|\bgraceful\b/i.test(content);
  const hasListenClose = /\.close\s*\(|\.listen\s*\(/.test(content);

  if (hasListenClose && !hasSigterm) {
    addFinding('MEDIUM', 'OPS-002', file, 1,
      'Server listens on a port but has no SIGTERM handler (OPS-002 §3).');
  }

  if (hasSigterm) {
    // Check shutdown sequence
    const hasDrain = /\bdrain\b|\bdraining\b/i.test(content);
    const hasDbClose = /\b(?:db|sequelize|database)\b.*\b(?:close|end|disconnect)\b/i.test(content);

    if (!hasDrain) {
      addFinding('LOW', 'OPS-002', file, 1,
        'SIGTERM handler should drain connections before closing (OPS-002 §4).');
    }
    if (!hasDbClose) {
      addFinding('LOW', 'OPS-002', file, 1,
        'SIGTERM handler should close DB connections (OPS-002 §4).');
    }
  }
}

// ── OPS-003: Health endpoints ───────────────────────────────────────────────

function checkHealthEndpoints(file, content) {
  if (!/\brouter\b|\bapp\.(get|use)\b/.test(content)) return;

  // Check for the three required endpoints
  const hasHealth = /\/health\b/.test(content);
  const hasReady = /\/ready\b/.test(content);
  const hasLive = /\/live\b/.test(content) || /\/liveness\b/.test(content);

  // Only flag actual server entry files (not router definition files)
  if (/\b(?:app\.listen|http\.createServer|https\.createServer)\b/.test(content)) {
    if (!hasHealth && !hasReady && !hasLive) {
      addFinding('MEDIUM', 'OPS-003', file, 1,
        'No health endpoints found — need /health, /ready, /live (OPS-003 §3).');
    }

    // Check for liveness probe (/health or /live)
    if (!hasHealth && !hasLive) {
      addFinding('MEDIUM', 'OPS-003', file, 1,
        'Missing liveness probe endpoint /health or /live (OPS-003 §3.1).');
    }
    // Check for readiness probe
    if (!hasReady) {
      addFinding('MEDIUM', 'OPS-003', file, 1,
        'Missing readiness probe endpoint /ready (OPS-003 §3.2).');
    }
  }
}

// ── OPS-003: Health check dependency caching ────────────────────────────────

function checkHealthCache(file, content) {
  if (!/\b(?:health|ready|live)\b/i.test(content)) return;

  // Check that health checks cache dependency results
  const hasCache = /\bcache\b|\bttl\b|\bmaxAge\b|\bdebounce\b/.test(content);
  if (/\/health/.test(content) && !hasCache) {
    addFinding('LOW', 'OPS-003', file, 1,
      'Health checks should cache dependency checks (recommended 30s, OPS-003 §3.3).');
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
    checkGracefulShutdown(file, content);
    checkHealthEndpoints(file, content);
    checkHealthCache(file, content);
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
    `\n[ops-health] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
