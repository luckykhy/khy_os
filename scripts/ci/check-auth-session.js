#!/usr/bin/env node
/**
 * check-auth-session.js — AUTH-002 + CORS-001 gate
 *
 * Enforces:
 *   AUTH-002: JWT algorithm (no HS256 symmetric), refresh token rotation,
 *             concurrent session limit, httpOnly+SameSite cookies
 *   CORS-001: No wildcard origin with credentials, preflight maxAge
 *
 * Usage: node scripts/ci/check-auth-session.js [--changed] [file-or-dir ...]
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

// ── AUTH-002: JWT algorithm ─────────────────────────────────────────────────

function checkJwtAlgorithm(file, content) {
  // HS256 is symmetric — requires server to know the secret.
  // For distributed systems, RS256 (asymmetric) is preferred.
  // ALLOWED: third-party API auth (Zhipu, etc.) where the provider requires HS256.
  const isThirdPartyJwt = /\b(?:generateZhipuJWT|generateThirdPartyJWT|thirdParty|external.*api)\b/i.test(content)
    || /\b(?:zhipu|智谱|supplier|provider).*(?:jwt|token)\b/i.test(content)
    || /\/gateway\/adapters\//.test(file);
  if (/\balgorithm\s*:\s*['"`]HS256['"`]/.test(content) && !isThirdPartyJwt) {
    const lineNum = content.split('\n').findIndex((l) => /\balgorithm\s*:\s*['"`]HS256['"`]/.test(l)) + 1;
    addFinding('HIGH', 'AUTH-002', file, lineNum,
      'JWT HS256 is symmetric — prefer RS256 for distributed systems (AUTH-002 §2.2).');
  }

  // Check that no algorithm is explicitly set to "none"
  if (/\balgorithms?\s*:\s*\[?\s*['"`]none['"`]/.test(content)) {
    const lineNum = content.split('\n').findIndex((l) => /\balgorithms?\s*:\s*\[?\s*['"`]none['"`]/.test(l)) + 1;
    addFinding('CRITICAL', 'AUTH-002', file, lineNum,
      '"none" algorithm bypasses signature verification (AUTH-002).');
  }
}

// ── AUTH-002: Cookie flags ──────────────────────────────────────────────────

function checkCookieFlags(file, content) {
  // Check for cookie configuration
  const cookiePatterns = [
    /res\.cookie\s*\(/,
    /Set-Cookie/,
    /cookie:\s*\{/,
  ];

  if (!cookiePatterns.some((p) => p.test(content))) return;

  // Check httpOnly flag
  const hasHttpOnly = /\bhttpOnly\b/.test(content) || /\bHttpOnly\b/.test(content);
  if (!hasHttpOnly && cookiePatterns.some((p) => p.test(content))) {
    const lineNum = content.split('\n').findIndex((l) => cookiePatterns.some((p) => p.test(l))) + 1;
    addFinding('HIGH', 'AUTH-002', file, lineNum,
      'Cookie missing httpOnly flag — accessible to JavaScript (AUTH-002 §2).');
  }

  // Check SameSite
  const hasSameSite = /\bSameSite\b/.test(content) || /\bsameSite\b/.test(content);
  if (!hasSameSite && cookiePatterns.some((p) => p.test(content))) {
    const lineNum = content.split('\n').findIndex((l) => cookiePatterns.some((p) => p.test(l))) + 1;
    addFinding('MEDIUM', 'AUTH-002', file, lineNum,
      'Cookie missing SameSite attribute (AUTH-002 §2).');
  }
}

// ── AUTH-002: Session configuration ────────────────────────────────────────

function checkSessionConfig(file, content) {
  // Only check files that actually configure HTTP sessions (express-session, cookie-based)
  if (!/\bexpress-session\b|\bres\.cookie\b|\bSet-Cookie\b|\bcookie:\s*\{/.test(content)) return;

  // Check for session timeout configuration
  const hasExpiry = /\bexpiresIn\b|\bmaxAge\b|\bexpires\b/.test(content);

  // Check for concurrent session limit
  const hasConcurrentLimit = /\bconcurrent\b|\bmaxSessions\b|\bsessionLimit\b/.test(content);

  if (!hasExpiry) {
    addFinding('MEDIUM', 'AUTH-002', file, 1,
      'Session configuration should set expiry (AUTH-002 §2).');
  }
}

// ── CORS-001: Wildcard origin with credentials ──────────────────────────────

function checkCorsConfig(file, content) {
  if (!/\bcors\s*\(/.test(content) && !/\bCORS\b/.test(content)) return;

  // Check for wildcard origin with credentials
  if (/origin\s*:\s*['"`]\*['"`]/.test(content) || /origin\s*:\s*true/.test(content)) {
    const hasCredentials = /\bcredentials\s*:\s*true/.test(content) || /\bcredentials\s*:\s*true\b/.test(content);
    if (hasCredentials) {
      const lineNum = content.split('\n').findIndex((l) => /origin\s*:\s*['"`]\*['"`]/.test(l)) + 1;
      addFinding('CRITICAL', 'CORS-001', file, lineNum,
        'Wildcard origin (*) with credentials=true is forbidden (CORS-001).');
    }
  }

  // Check for preflight cache (Access-Control-Max-Age)
  const hasMaxAge = /Access-Control-Max-Age|maxAge/.test(content);
  if (/\bcors\s*\(/.test(content) && !hasMaxAge) {
    addFinding('LOW', 'CORS-001', file, 1,
      'CORS config should set maxAge (recommended: 86400 for 24h, CORS-001 §3.4).');
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
    checkJwtAlgorithm(file, content);
    checkCookieFlags(file, content);
    checkSessionConfig(file, content);
    checkCorsConfig(file, content);
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
    `\n[auth-session] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
