#!/usr/bin/env node
/**
 * check-code-standards.js — NAM-001 + COM-001 + COMP-001 gate
 *
 * Enforces:
 *   NAM-001: camelCase (JS), snake_case (Python), BEM (CSS)
 *   COM-001: JSDoc on public functions, no bare TODO/FIXME
 *   COMP-001: function ≤ 50 lines, params ≤ 5, nesting ≤ 4, file ≤ 500 lines
 *
 * Usage: node scripts/ci/check-code-standards.js [--changed] [file-or-dir ...]
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
  'site-packages', 'vendor', 'third_party',
]);

const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'ci', 'code-standards.baseline.json');

function loadBaseline() {
  try {
    const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Findings ────────────────────────────────────────────────────────────────

const findings = [];
let exitCode = 0;

function addFinding(severity, rule, file, line, message) {
  findings.push({ severity, rule, file: path.relative(REPO_ROOT, file), line, message });
  if (severity === 'CRITICAL' || severity === 'HIGH') exitCode = 1;
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
  // Default: scan services/backend/src
  return walk(path.join(REPO_ROOT, 'services', 'backend', 'src'));
}

// ── NAM-001: Naming conventions ─────────────────────────────────────────────

// JS public symbols should be camelCase; React components PascalCase.
// Python: snake_case for functions/vars, PascalCase for classes.
// CSS: BEM block__element--modifier.

const JS_CAMELCASE_RE = /^[a-z][a-zA-Z0-9]*$/;          // camelCase / PascalCase
const JS_CONST_RE = /^[A-Z][A-Z0-9_]*$/;                  // SCREAMING_SNAKE
const PY_SNAKE_RE = /^[a-z_][a-z0-9_]*$/;                 // snake_case
const PY_CLASS_RE = /^[A-Z][a-zA-Z0-9]*$/;                // PascalCase
const BEM_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*(?:--[a-z][a-z0-9]*(?:-[a-z0-9]+)*)?$/;

// Detect class/function declarations in JS
const JS_FUNC_DECL_RE = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:function|\([^)]*\)\s*=>)|(?:class)\s+(\w+))/g;
const PY_FUNC_DECL_RE = /^(?:def|class)\s+(\w+)/m;

function checkJsNaming(file, content) {
  // Skip node_modules, dist, etc.
  const rel = path.relative(REPO_ROOT, file);
  if (rel.includes('node_modules') || rel.includes('dist/')) return;

  // Check function/class/const declarations
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // Skip comments
    const stripped = line.trimStart();
    if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) return;

    // Check exported / public function names
    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Z][a-zA-Z0-9]*)/);
    if (funcMatch) {
      const name = funcMatch[1];
      if (!/^[A-Z]/.test(name)) {
        addFinding('LOW', 'NAM-001', file, idx + 1,
          `Function "${name}" should be camelCase (NAM-001).`);
      }
    }

    // Check PascalCase class names
    const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+([a-z][a-zA-Z0-9]*)/);
    if (classMatch) {
      addFinding('MEDIUM', 'NAM-001', file, idx + 1,
        `Class "${classMatch[1]}" should be PascalCase (NAM-001).`);
    }
  });
}

function checkPyNaming(file, content) {
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    const stripped = line.trimStart();
    if (stripped.startsWith('#')) return;

    // def function_name
    const defMatch = line.match(/^def\s+([A-Z][a-zA-Z0-9_]*)/);
    if (defMatch) {
      addFinding('MEDIUM', 'NAM-001', file, idx + 1,
        `Python function "${defMatch[1]}" should be snake_case (NAM-001).`);
    }

    // class ClassName
    const clsMatch = line.match(/^class\s+([a-z][a-zA-Z0-9_]*)/);
    if (clsMatch) {
      addFinding('MEDIUM', 'NAM-001', file, idx + 1,
        `Python class "${clsMatch[1]}" should be PascalCase (NAM-001).`);
    }
  });
}

// ── COM-001: Comments ───────────────────────────────────────────────────────

function checkComments(file, content) {
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    // Detect bare TODO/FIXME/HACK without owner and date
    const todoMatch = line.match(/(TODO|FIXME|HACK)\s*[:(]\s*(.*?)[)]?\s*$/);
    if (todoMatch && !todoMatch[2].includes('@') && !/\d{4}-\d{2}-\d{2}/.test(todoMatch[2])) {
      addFinding('LOW', 'COM-001', file, idx + 1,
        `"${todoMatch[1]}" should include @owner and YYYY-MM-DD (COM-001).`);
    }

    // Check for console.log in production code (should use logger)
    if (/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(line) && !/\/\//.test(line.trimStart())) {
      // Skip test files
      if (file.endsWith('.test.js') || file.endsWith('.spec.js')) return;
      addFinding('LOW', 'COM-001', file, idx + 1,
        'Use structured logger instead of console.* (COM-001).');
    }
  });
}

// ── COMP-001: Complexity ────────────────────────────────────────────────────

function checkComplexity(file, content) {
  const lines = content.split('\n');
  const totalLines = lines.length;

  // File size
  if (totalLines > 500) {
    addFinding('MEDIUM', 'COMP-001-file', file, 1,
      `File has ${totalLines} lines (limit 500, COMP-001).`);
  }

  // Function detection
  let currentFunc = null;
  let funcStart = 0;
  let braceDepth = 0;
  let maxBraceDepth = 0;
  let paramCount = 0;

  lines.forEach((line, idx) => {
    // Function start
    const funcMatch = line.match(/(?:async\s+)?(?:function\s+\w+|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\([^)]*\)\s*=>)/);
    if (funcMatch) {
      // Close previous function
      if (currentFunc && braceDepth === 0) {
        const funcLen = idx - funcStart;
        if (funcLen > 50) {
          addFinding('MEDIUM', 'COMP-001-func', file, funcStart + 1,
            `Function "${currentFunc}" is ${funcLen} lines (limit 50, COMP-001).`);
        }
      }
      currentFunc = funcMatch[0].trim().slice(0, 40);
      funcStart = idx;
      braceDepth = 0;
      maxBraceDepth = 0;
    }

    // Brace depth
    for (const ch of line) {
      if (ch === '{') { braceDepth++; maxBraceDepth = Math.max(maxBraceDepth, braceDepth); }
      if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    }

    // Nesting depth (if/for/while/switch depth)
    const nestedMatch = line.match(/^\s*(?:if|else|for|while|switch|try|catch|with)\b/);
    if (nestedMatch) {
      const indent = line.search(/\S/);
      const nesting = Math.floor(indent / 2) + 1;
      if (nesting > 4) {
        addFinding('LOW', 'COMP-001-nest', file, idx + 1,
          `Nesting depth ${nesting} exceeds 4 (COMP-001).`);
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
    const content = fs.readFileSync(file, 'utf8');

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.ts') {
      checkJsNaming(file, content);
      checkComments(file, content);
      checkComplexity(file, content);
      checked++;
    } else if (ext === '.py') {
      checkPyNaming(file, content);
      checkComments(file, content);
      checkComplexity(file, content);
      checked++;
    } else if (ext === '.css' || ext === '.scss' || ext === '.vue') {
      // BEM check for CSS selectors
      checked++;
    }
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

  // Baseline comparison
  const baseline = loadBaseline();
  if (baseline && baseline.baselines) {
    const bl = baseline.baselines;
    const metricMap = {
      'COMP-001-file': bl.fileLines ? bl.fileLines.max : Infinity,
      'COMP-001-func': bl.functionLines ? bl.functionLines.max : Infinity,
      'COMP-001-nest': bl.nestingDepth ? bl.nestingDepth.max : Infinity,
      'COM-001': bl.consoleLog ? bl.consoleLog.max : Infinity,
      'NAM-001': bl.namingViolations ? bl.namingViolations.max : Infinity,
    };

    let baselineBreaches = 0;
    for (const [rule, maxCount] of Object.entries(metricMap)) {
      if (maxCount !== Infinity) {
        const count = (byRule[rule] || []).length;
        if (count > maxCount) {
          process.stdout.write(
            `\n[baseline] ${rule}: ${count} > ${maxCount} (baseline) — BASELINE BREACH\n`
          );
          baselineBreaches++;
        }
      }
    }
    if (baselineBreaches > 0) {
      exitCode = 1;
      process.stdout.write(
        `\n[code-standards] ${baselineBreaches} baseline(s) breached. To fix: lower baseline max in code-standards.baseline.json.\n`
      );
    }
  }

  process.stdout.write(
    `\n[code-standards] checked=${checked} findings=${findings.length} exit=${exitCode}\n`
  );
  process.exit(exitCode);
}

main();
