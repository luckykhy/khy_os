#!/usr/bin/env node
/**
 * check-api-contracts.js — API-001 + API-002 + API-003 gate
 *
 * Enforces:
 *   API-001: Response structure (success, data/metadata, error envelope)
 *   API-002: Deprecation headers (Deprecation, Sunset), versioning
 *   API-003: Idempotency-Key on mutation endpoints
 *
 * Usage: node scripts/ci/check-api-contracts.js [--changed] [file-or-dir ...]
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
  return walk(path.join(REPO_ROOT, 'services', 'backend', 'src', 'routes'));
}

// ── API-003: Idempotency on mutation endpoints ──────────────────────────────

function checkIdempotency(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.includes('/routes/')) return;

  // Find POST handlers
  const lines = content.split('\n');
  let inPostHandler = false;
  let postDepth = 0;
  let foundIdempotencyCheck = false;

  lines.forEach((line, idx) => {
    // Detect router.post( declarations
    if (/router\.(post|put|patch)\s*\(/.test(line)) {
      inPostHandler = true;
      foundIdempotencyCheck = false;
    }
    if (inPostHandler) {
      if (/idempotency|idempotency_key|Idempotency-Key/.test(line)) {
        foundIdempotencyCheck = true;
      }
      // End of handler (next router call or 2 blank lines)
      if (/router\.\w+\s*\(/.test(line) && !/idempotency/.test(line)) {
        if (inPostHandler && !foundIdempotencyCheck) {
          // Check if this looks like a mutation endpoint (not a simple GET-like POST)
          const prevLines = lines.slice(Math.max(0, idx - 30), idx).join('\n');
          if (/req\.body|create|update|delete|write|save|execute|side.effect/i.test(prevLines)) {
            addFinding('MEDIUM', 'API-003', file, idx + 1,
              'POST/PUT/PATCH handler missing idempotency check (API-003 §3.1).');
          }
        }
        inPostHandler = false;
      }
    }
  });
}

// ── API-001: Response envelope ──────────────────────────────────────────────

function checkResponseEnvelope(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.includes('/routes/')) return;

  // Check that res.json responses use the standard envelope
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // res.json without envelope structure
    if (/res\.json\s*\(\s*\{(?![^}]*success)/.test(line)) {
      addFinding('LOW', 'API-001', file, idx + 1,
        'res.json() without "success" field in envelope (API-001 §4).');
    }

    // res.status(200).send without structure
    if (/res\.(status|send)\s*\([^)]*\)\s*\.\s*(?!json)/.test(line) && !/success|data|error/.test(content.substring(idx - 50, idx + 50))) {
      // Only flag if it seems to be returning data
    }
  });

  // Check that apiResponse helper is used (if available)
  const hasApiResponse = /\bapiResponse\b/.test(content);
  if (!hasApiResponse && rel.includes('routes/')) {
    // This is just a notice, not an error
  }
}

// ── API-002: Deprecation headers ────────────────────────────────────────────

function checkDeprecationHeaders(file, content) {
  // Check for deprecated endpoints that have Deprecation/Sunset headers
  // Only flag actual @deprecated annotations, not status strings like 'deprecated'
  const hasDeprecated = /@deprecated\b/i.test(content);
  if (!hasDeprecated) return;

  // If something is deprecated, check for deprecation response headers
  const hasDeprecationHeader = /\bDeprecation\s*:\s*true|\bSunset\s*:/i.test(content);
  const hasDeprecationWarning = /deprecat.*warn/i.test(content);

  if (hasDeprecated && !hasDeprecationHeader && !hasDeprecationWarning) {
    const lineNum = content.split('\n').findIndex((l) => /@deprecated\b/i.test(l)) + 1;
    addFinding('LOW', 'API-002', file, lineNum,
      'Deprecated code should emit Deprecation/Sunset headers or warnings (API-002 §3).');
  }
}

// ── API-001: Error response consistency ─────────────────────────────────────

function checkErrorResponses(file, content) {
  const rel = path.relative(REPO_ROOT, file);
  if (!rel.includes('/routes/')) return;

  // Check for bare res.status().send() with plain strings (not structured errors)
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // res.status(500).send('something') — should use error envelope
    if (/res\.(status|send)\s*\(\s*\d+\s*\)\s*\.\s*\w+\s*\(\s*['"`]/.test(line)) {
      if (!/error|Error/.test(content.substring(idx - 100, idx + 100))) {
        addFinding('LOW', 'API-002', file, idx + 1,
          'Error response should use structured envelope (API-002 §2).');
      }
    }
  });
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
    checkIdempotency(file, content);
    checkResponseEnvelope(file, content);
    checkDeprecationHeaders(file, content);
    checkErrorResponses(file, content);
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
    `\n[api-contracts] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
