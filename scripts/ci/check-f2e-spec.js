#!/usr/bin/env node
'use strict';

/**
 * check-f2e-spec.js — PR: f2e-spec-beautify
 *
 * Mechanical check for the F2E Spec (Alibaba frontend code style) rules
 * that aren't already covered by Prettier / eslint-vue3-recommended.
 * Scope: PR-touched files (passed as args) plus a few always-on safety
 * scans for v-html and target="_blank" without rel="noopener noreferrer".
 *
 * Coverage:
 *   1. Forbidden: var declarations (F2E §2 强制)
 *   2. Forbidden: == / != (F2E §2 强制 ===/!==)
 *   3. Forbidden: console.log/warn/error outside import.meta.env.DEV
 *      (F2E §7 推荐 — only flag in .vue / .js / .ts sources, not tests)
 *   4. Forbidden: target="_blank" without rel="noopener noreferrer"
 *      (F2E §7 强制)
 *   5. Forbidden: v-html= in production code
 *      (F2E §7 推荐 — list occurrences for human review)
 *   6. Forbidden: eval( / new Function( (F2E §7 强制)
 *
 * Exits 0 when clean, 1 when violations are found. Print the file:line
 * and rule id so reviewers can fix at the source.
 *
 * Usage:
 *   node scripts/ci/check-f2e-spec.js <file1.js> <file2.vue> ...
 *   node scripts/ci/check-f2e-spec.js           # scans apps/ai-frontend/src
 *                                                # + services/backend/src/bridge
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

function defaultScope() {
  const out = [];
  const roots = [
    'apps/ai-frontend/src',
    'services/backend/src/bridge',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, out);
  }
  return out;
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(vue|js|ts)$/.test(ent.name)) {
      // Skip test files (they often use loose equality intentionally).
      if (/\.(test|spec)\.js$|\.(test|spec)\.ts$/.test(ent.name)) continue;
      out.push(p);
    }
  }
}

const files = args.length ? args : defaultScope();

const RULES = [
  {
    id: 'F2E-2.1',
    name: 'no-var',
    re: /\bvar\s+[A-Za-z_$]/,
  },
  {
    id: 'F2E-2.2',
    name: 'strict-equality',
    // Catch == and != when not part of !== or ===. (Lookarounds: not after = or !)
    re: /(?<![=!])(==|!=)(?!=)/,
  },
  {
    id: 'F2E-2.3',
    name: 'no-eval',
    re: /\b(eval|new\s+Function)\s*\(/,
  },
  {
    id: 'F2E-7.1',
    name: 'target-blank-missing-rel',
    re: /target=("|')_blank\1(?![\s\S]{0,80}rel=("|')noopener\s+noreferrer\2)/i,
  },
  {
    id: 'F2E-7.2',
    name: 'v-html-in-prod',
    re: /\bv-html\s*=/,
  },
];

// Files where console.* is the product output, not debug logging. These are
// CLI handlers and server status printers — F2E §7 targets browser debug logs,
// not user-facing CLI banners. Add a file here only if you've audited that
// every console.* in it is user-visible.
const CONSOLE_WHITELIST = new Set([
  'services/backend/src/bridge/bridgeServer.js',
  'services/backend/src/cli/handlers/gatewayManageDaemon.js',
]);

const violations = [];

for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split(/\r?\n/);
  const relFile = f.replace(/\\/g, '/');
  const isConsoleWhitelisted = CONSOLE_WHITELIST.has(relFile);

  // Track whether this file is a Vue SFC; v-html is Vue-only, console rule
  // applies to all .vue/.js/.ts but ignores lines that explicitly guard
  // with import.meta.env.DEV / NODE_ENV checks.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines (loose — anything starting with //)
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Rule: console.* in production code
    if (/\bconsole\.(log|warn|error|info|debug)\b/.test(line)) {
      // Allow if the surrounding 3 lines include DEV guard
      const ctx = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      const allowed = /import\.meta\.env\.DEV|process\.env\.NODE_ENV|__DEV__/.test(ctx);
      if (!allowed && !isConsoleWhitelisted) {
        // Allow CLI user-facing output helpers: printStatus / printToken /
        // printNginxConfig / printHelp / etc. These are called by CLI subcommands
        // (e.g. `bridge status`, `bridge nginx`) and ARE the product output.
        // F2E §7 targets debug logs, not user-visible CLI banners.
        const ctxWide = lines.slice(0, i + 1).join('\n');
        const inPrintHelper = /\bfunction\s+print[A-Z]\w*\s*\(/.test(ctxWide)
          || /\bconst\s+print[A-Z]\w*\s*=\s*\(/.test(ctxWide);
        if (!inPrintHelper) {
          violations.push({ file: f, line: i + 1, rule: 'F2E-7.3', name: 'console-in-prod', text: line.trim() });
        }
      }
    }

    // Other rules — apply generic re match
    for (const r of RULES) {
      if (r.id === 'F2E-7.2' && !/\.vue$/.test(f)) continue; // v-html only in Vue
      if (r.re.test(line)) {
        // For target=_blank: only flag if rel="noopener noreferrer" not within 80 chars on same line
        if (r.id === 'F2E-7.1') {
          // already gated by negative lookahead in the regex
        }
        violations.push({ file: f, line: i + 1, rule: r.id, name: r.name, text: line.trim() });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`F2E Spec check passed: ${files.length} file(s) scanned, 0 violations.`);
  process.exit(0);
}

const byRule = {};
for (const v of violations) {
  byRule[v.rule] = (byRule[v.rule] || 0) + 1;
}

console.log(`F2E Spec check found ${violations.length} violation(s) across ${Object.keys(byRule).length} rule(s):`);
for (const [r, n] of Object.entries(byRule).sort()) {
  console.log(`  ${r}: ${n}`);
}
console.log('');
for (const v of violations.slice(0, 50)) {
  console.log(`  ${v.file}:${v.line}  [${v.rule} ${v.name}]`);
  console.log(`    ${v.text.slice(0, 120)}`);
}
if (violations.length > 50) {
  console.log(`  ... and ${violations.length - 50} more`);
}

// Default-scope (no args) is advisory: print the report but exit 0 so the
// project-wide baseline stays a TODO rather than a hard CI failure. Explicit
// file args (PR-scoped) are strict and exit 1 to gate the PR.
if (args.length === 0) {
  console.log('');
  console.log('Default scope = advisory. Pass explicit files for strict gating.');
  process.exit(0);
}
process.exit(1);
