#!/usr/bin/env node
/**
 * check-security-headers.js — SEC-001 §8 + input validation gate
 *
 * Enforces:
 *   SEC-001: helmet() usage, security headers (HSTS, X-Frame-Options, CSP, etc.)
 *   Input validation: joi/zod schemas on POST/PUT/PATCH endpoints
 *   SQL injection: no string concatenation in queries
 *   XSS: no dangerouslySetInnerHTML without sanitization
 *
 * Usage: node scripts/ci/check-security-headers.js [--changed] [file-or-dir ...]
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

// ── SEC-001 §8: Security Headers ────────────────────────────────────────────

function checkSecurityHeaders(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.startsWith('services/backend/src/')) return;

  // Rule 1: helmet() must be used in app setup
  if (/\bapp\.use\s*\(\s*helmet\s*\(/.test(content)) {
    addFinding('INFO', 'SEC-001', file, 1,
      'helmet() detected (good).');
  } else if (/\bexpress\s*\(\)\s*;/.test(content) && !/\bhelmet\b/.test(content)) {
    // Only flag main server files, not individual route files
    if (/(app\.js|server\.js|index\.js|main\.js)$/.test(file)) {
      addFinding('HIGH', 'SEC-001', file, 1,
        'Express app without helmet() middleware (SEC-001 §8).');
    }
  }

  // Rule 2: Check for dangerouslySetInnerHTML (XSS risk)
  const dangerouslyPattern = /dangerouslySetInnerHTML\s*=\s*\{\{[\s\S]*?\}\}/g;
  const matches = content.match(dangerouslyPattern);
  if (matches) {
    for (const m of matches) {
      // Check if it's sanitized
      const hasSanitize = /\bsanitize\b|\bxss\b|\bDOMPurify\b|\bescapeHtml\b/i.test(content);
      if (!hasSanitize) {
        const lineNum = content.substring(0, content.indexOf(m)).split('\n').length;
        addFinding('HIGH', 'SEC-001', file, lineNum,
          'dangerouslySetInnerHTML without visible sanitization (XSS risk, SEC-001 §5.3).');
      }
    }
  }

  // Rule 3: Check for innerHTML assignment
  if (/\.innerHTML\s*=/.test(content) && !/test|spec|__tests__/.test(file)) {
    const lineNum = content.split('\n').findIndex((l) => /\.innerHTML\s*=/.test(l)) + 1;
    addFinding('MEDIUM', 'SEC-001', file, lineNum,
      'Direct innerHTML assignment is an XSS risk (SEC-001 §5.3).');
  }
}

// ── SQL Injection detection ─────────────────────────────────────────────────

function checkSqlInjection(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.startsWith('services/backend/src/')) return;

  // Detect string concatenation in SQL queries
  // Pattern: `SELECT ... ${var}` or `"SELECT ... " + var`
  const sqlConcatPatterns = [
    /(?:query|execute|raw)\s*\(\s*[`'`][^`'`]*\$\{/,          // Template literal in query
    /(?:query|execute|raw)\s*\(\s*[`'`][^`'`]*\+/,             // String concat in query
    /(?:sequelize\.query|db\.query)\s*\(\s*.*\+.*\)/i,          // Direct concatenation
  ];

  // These patterns flag potential SQL injection but we need to check
  // if the interpolated value is a parameter (safe) or raw user input (unsafe)
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // Check for template literal with variable interpolation in SQL context
    if (/\$\{.*\}.*(?:query|execute|sql|SELECT|INSERT|UPDATE|DELETE)/i.test(line)) {
      // Check if it's using parameterized queries (safe)
      const isParametrized = /replacements\s*:|bind\s*:|:param/i.test(content);
      if (!isParametrized) {
        addFinding('HIGH', 'SEC-001', file, idx + 1,
          'Possible SQL injection: template literal interpolation in query without parameterization (SEC-001 §5.2).');
      }
    }
  });
}

// ── Input validation (Joi/Zod) ───────────────────────────────────────────────

function checkInputValidation(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.includes('/routes/')) return;

  // Check if route handlers have validation middleware
  const hasValidation = /\bvalidate\s*\(|\.validate\s*\(|check\s*\(/.test(content);
  const hasJoi = /\bjoi\b|\bJoi\b/.test(content);
  const hasZod = /\bzod\b/.test(content);

  // For POST/PUT/PATCH routes, check if req.body is used without validation
  const lines = content.split('\n');
  const usesReqBody = lines.some((l) => /\breq\.body\b/.test(l));
  const usesReqQuery = lines.some((l) => /\breq\.query\b/.test(l));

  if ((usesReqBody || usesReqQuery) && !hasValidation && !hasJoi && !hasZod) {
    // Check if this is a POST/PUT/PATCH handler
    const hasMutationMethod = /\b(?:post|put|patch|delete)\s*\(/.test(content);
    if (hasMutationMethod) {
      addFinding('MEDIUM', 'SEC-001', file, 1,
        'Route uses req.body/req.query without visible validation middleware (SEC-001 §5.1).');
    }
  }
}

// ── Sensitive data in logs ──────────────────────────────────────────────────

function checkSensitiveDataInLogs(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.startsWith('services/backend/src/')) return;

  const sensitiveFields = [
    'password', 'token', 'apiKey', 'api_key', 'secret', 'authorization',
    'privateKey', 'private_key', 'credential', 'credentials',
  ];

  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    // Check if logging includes sensitive fields without redaction
    for (const field of sensitiveFields) {
      if (lower.includes(field) && /\b(log|logger|console|warn|info|debug|error)\b/.test(lower)) {
        // Check if it's sanitized
        const hasRedact = /\b(sanitize|mask|redact|scrub)\b/.test(lower);
        if (!hasRedact) {
          addFinding('MEDIUM', 'SEC-001', file, idx + 1,
            `Possible sensitive data in log: "${field}" (SEC-001 §9.1).`);
        }
      }
    }
  });
}

// ── Crypto: weak algorithms ─────────────────────────────────────────────────

function checkCryptoAlgorithms(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.startsWith('services/backend/src/')) return;

  // Disallow weak hash algorithms
  const weakAlgos = /\bmd5\b|\bsha1\b|\bdes\b|\b3des\b|\bRC4\b/i;
  if (weakAlgos.test(content) && !/test|spec|__tests__|\.test\./.test(file)) {
    const lineNum = content.split('\n').findIndex((l) => weakAlgos.test(l)) + 1;
    addFinding('HIGH', 'SEC-001', file, lineNum,
      'Weak cryptographic algorithm detected (SEC-001 §4.2).');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = targets();
  let checked = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (!['.js', '.ts', '.tsx', '.vue'].includes(ext)) continue;

    const content = fs.readFileSync(file, 'utf8');
    checkSecurityHeaders(file, content);
    checkSqlInjection(file, content);
    checkInputValidation(file, content);
    checkSensitiveDataInLogs(file, content);
    checkCryptoAlgorithms(file, content);
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
    `\n[security-headers] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
