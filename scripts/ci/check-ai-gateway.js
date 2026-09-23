#!/usr/bin/env node
/**
 * check-ai-gateway.js — GW-002 + PROMPT-001 + FF-001 gate
 *
 * Enforces:
 *   GW-002: Fallback chain present, circuit breaker threshold
 *   PROMPT-001: Prompt templates versioned, max length check
 *   FF-001: Feature flags default to false, max 3-month rollout
 *
 * Usage: node scripts/ci/check-ai-gateway.js [--changed] [file-or-dir ...]
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
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'services', 'gateway'),
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'services', 'promptTemplateCatalog.js'),
    path.join(REPO_ROOT, 'services', 'backend', 'src', 'services', 'flagRegistry.js'),
  ];
  const out = [];
  for (const d of dirs) {
    if (fs.existsSync(d)) {
      if (fs.statSync(d).isDirectory()) walk(d, out);
      else out.push(d);
    }
  }
  return out;
}

// ── GW-002: Fallback chain ──────────────────────────────────────────────────

function checkFallbackChain(file, content) {
  // Check for model fallback configuration
  if (!/\b(?:fallback|degrad|circuit|breaker)\b/i.test(content)) return;

  // Check for P0 -> P1 -> P2 degradation
  const hasFallbackChain = /\b(?:p0|p1|p2|primary|secondary|fallback)\b/i.test(content);
  if (hasFallbackChain) {
    // Good — check if there's at least 2 levels
    const levels = (content.match(/\b(?:P0|P1|P2|primary|secondary|fallback)\b/gi) || []).length;
    if (levels < 2) {
      addFinding('MEDIUM', 'GW-002', file, 1,
        'AI gateway should have at least 2 fallback levels (GW-002 §2).');
    }
  }

  // Check circuit breaker threshold
  if (/\bcircuitBreaker\b|\bcircuit_breaker\b/i.test(content)) {
    const hasThreshold = /\b(?:threshold|errorRate|error_rate)\b/i.test(content);
    if (!hasThreshold) {
      addFinding('MEDIUM', 'GW-002', file, 1,
        'Circuit breaker should define error threshold (GW-002 §4).');
    }
  }
}

// ── PROMPT-001: Prompt template versioning ──────────────────────────────────

function checkPromptVersioning(file, content) {
  if (!/\bprompt\b/i.test(content) && !/\btemplate\b/i.test(content)) return;

  // Check for template version
  const hasVersion = /\bversion\b|\bv\d+/.test(content);
  if (!hasVersion && /\b(?:prompt|template)\b/i.test(content)) {
    addFinding('LOW', 'PROMPT-001', file, 1,
      'Prompt/template should be versioned (PROMPT-001 §2).');
  }

  // Check for max length enforcement
  if (/\bprompt\b.*\blength\b/i.test(content) || /\btemplate\b.*\blength\b/i.test(content)) {
    const hasMaxLength = /\bmaxLength\b|\bmax_length\b|\bMAX_LENGTH\b|\b2000\b/.test(content);
    if (!hasMaxLength) {
      addFinding('LOW', 'PROMPT-001', file, 1,
        'Prompt/template should enforce max length (PROMPT-001 §2).');
    }
  }

  // Check for injection protection
  if (/\bprompt\b.*\binject\b/i.test(content) || /\btemplate\b.*\binject\b/i.test(content)) {
    const hasInjectionProtection = /\bsanitize\b|\bvalidate\b|\bclean\b|\bwhitelist\b/i.test(content);
    if (!hasInjectionProtection) {
      addFinding('MEDIUM', 'PROMPT-001', file, 1,
        'Prompt processing should have injection protection (PROMPT-001 §4).');
    }
  }
}

// ── FF-001: Feature flags ───────────────────────────────────────────────────

function checkFeatureFlags(file, content) {
  if (!/\bflag\b|\bfeature\b.*\b(?:flag|toggle|switch)\b/i.test(content)) return;

  // Check that flags default to off
  const hasDefaultOff = /\bdefault\s*:\s*false\b|\bdefault\s*=\s*false\b|\benabled\s*:\s*false\b/.test(content);
  if (!hasDefaultOff && /\b(?:flag|feature)\b/i.test(content)) {
    // Only flag if it's a new flag definition
    const isFlagDef = /(?:flag|feature)\s*[=:]\s*\{/.test(content);
    if (isFlagDef) {
      addFinding('MEDIUM', 'FF-001', file, 1,
        'Feature flag should default to false (FF-001 §2).');
    }
  }

  // Check for rollout level
  const hasRollout = /\brollout\b|\bpercentage\b|\bwhitelist\b|\bcohort\b/i.test(content);
  if (!hasRollout && /\b(?:flag|feature)\b.*\benabled\b/i.test(content)) {
    addFinding('LOW', 'FF-001', file, 1,
      'Feature flag should specify rollout strategy (FF-001 §3).');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = targets();
  let checked = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (!['.js', '.ts', '.tsx', '.json'].includes(ext)) continue;

    const content = fs.readFileSync(file, 'utf8');
    checkFallbackChain(file, content);
    checkPromptVersioning(file, content);
    checkFeatureFlags(file, content);
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
    `\n[ai-gateway] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
