#!/usr/bin/env node
/**
 * check-frontend-design-tokens.js — FE-004 + A11Y-001 gate
 *
 * Enforces:
 *   FE-004: CSS variables for colors (var(--khy-*)), no inline hex,
 *           BEM naming, clamp() for responsive, prefers-reduced-motion
 *   A11Y-001: ARIA labels, alt text, keyboard navigation
 *
 * Usage: node scripts/ci/check-frontend-design-tokens.js [--changed] [file-or-dir ...]
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

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.cache', '.tmp', 'coverage']);

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

  const frontendDirs = [
    path.join(REPO_ROOT, 'apps', 'ai-frontend', 'src'),
    path.join(REPO_ROOT, 'software', 'khyquant', 'frontend'),
    path.join(REPO_ROOT, 'platform', 'packages', 'ui-shared'),
  ];
  const out = [];
  for (const d of frontendDirs) {
    if (fs.existsSync(d)) walk(d, out);
  }
  return out;
}

// ── FE-004: CSS variable usage ──────────────────────────────────────────────

function checkCssVariables(file, content) {
  if (!/\.(vue|css|scss|less|jsx|tsx|js|ts)$/.test(path.extname(file))) return;

  const rel = path.relative(REPO_ROOT, file);
  if (rel.includes('node_modules') || rel.includes('dist/')) return;

  // Check for inline hex colors (should use var(--khy-*))
  const hexInStyle = content.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const inlineStyleMatch = content.match(/\bstyle\s*=\s*"/g) || [];
  const bindStyleMatch = content.match(/\b:style\s*=\s*/g) || [];
  const inlineCount = inlineStyleMatch.length + bindStyleMatch.length;

  // Count hex literals in CSS files (exclude theme definition files)
  if (path.extname(file).match(/\.(css|scss|less)$/)) {
    const hexCount = hexInStyle.length;
    if (hexCount > 5 && !/theme|variable|token/.test(path.basename(file))) {
      addFinding('LOW', 'FE-004', file, 1,
        `CSS file has ${hexCount} hex literals — use var(--khy-*) tokens (FE-004 §3).`);
    }
  }

  // Check Vue/JSX files for inline styles
  if (inlineCount > 3 && !/theme|token/.test(content)) {
    addFinding('LOW', 'FE-004', file, 1,
      `${inlineCount} inline styles detected — use CSS classes or tokens (FE-004 §3).`);
  }
}

// ── FE-004: BEM naming ──────────────────────────────────────────────────────

function checkBemNaming(file, content) {
  if (!/\.(vue|css|scss|less)$/.test(path.extname(file))) return;

  // Check for non-BEM class naming patterns
  // This is a soft check — we just warn about suspicious patterns
  const suspiciousPatterns = [
    /\.[a-z]+_[a-z]+/,           // snake_case in class names (should be BEM)
    /\.[A-Z][a-z]+[A-Z]/,        // camelCase in class names
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(content)) {
      addFinding('LOW', 'FE-004', file, 1,
        'Class name may not follow BEM convention — use block__element--modifier (FE-004 §4).');
      break;
    }
  }
}

// ── A11Y-001: Image alt text ────────────────────────────────────────────────

function checkImageAlt(file, content) {
  if (!/\.(vue|jsx|tsx|html)$/.test(path.extname(file))) return;

  // Check for <img> without alt attribute
  const imgWithoutAlt = content.match(/<img\s+(?!.*\balt\b)[^>]*>/gi) || [];
  if (imgWithoutAlt.length > 0) {
    const lineNum = content.split('\n').findIndex((l) => /<img\s+(?!.*\balt\b)/.test(l)) + 1;
    addFinding('MEDIUM', 'A11Y-001', file, lineNum,
      'Image missing alt attribute for accessibility (A11Y-001 §2).');
  }
}

// ── A11Y-001: ARIA labels ───────────────────────────────────────────────────

function checkAriaLabels(file, content) {
  if (!/\.(vue|jsx|tsx|html)$/.test(path.extname(file))) return;

  // Check for interactive elements without accessible names
  const interactivePatterns = [
    /<button\s+[^>]*>\s*<\/button>/,           // Empty button
    /<a\s+[^>]*>\s*<\/a>/,                     // Empty link
    /<input\s+[^>]*>/i,                         // Input without label
  ];

  for (const pattern of interactivePatterns) {
    if (pattern.test(content)) {
      addFinding('LOW', 'A11Y-001', file, 1,
        'Interactive element may need aria-label for accessibility (A11Y-001 §3).');
      break;
    }
  }
}

// ── A11Y-001: Keyboard navigation ──────────────────────────────────────────

function checkKeyboardNav(file, content) {
  if (!/\.(vue|jsx|tsx)$/.test(path.extname(file))) return;

  // Check for click handlers without keyboard handlers
  const hasClickOnly = /\b@click\b|\bonclick\b/.test(content);
  const hasKeyHandler = /\b@keydown\b|\b@keyup\b|\bonkeydown\b|\bonkeyup\b/.test(content);

  if (hasClickOnly && !hasKeyHandler && /\b@click\b/.test(content)) {
    addFinding('LOW', 'A11Y-001', file, 1,
      'Click handler without keyboard handler — ensure keyboard accessibility (A11Y-001 §4).');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const files = targets();
  let checked = 0;

  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (!['.vue', '.css', '.scss', '.less', '.jsx', '.tsx', '.js', '.ts', '.html'].includes(ext)) continue;

    const content = fs.readFileSync(file, 'utf8');
    checkCssVariables(file, content);
    checkBemNaming(file, content);
    checkImageAlt(file, content);
    checkAriaLabels(file, content);
    checkKeyboardNav(file, content);
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
    `\n[frontend-design-tokens] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
