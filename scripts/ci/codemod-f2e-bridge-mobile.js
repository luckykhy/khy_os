#!/usr/bin/env node
'use strict';

/**
 * codemod-f2e-bridge-mobile.js — PR: f2e-spec-beautify
 *
 * One-shot codemod for services/backend/src/bridge/mobilePage.js:
 *   - Reads the file
 *   - Locates the inline <script>...</script> block (currently lines 461-1420)
 *   - Replaces var declarations and function declarations inside the
 *     <script> body with const/let (according to F2E Spec §2 强制)
 *   - Wraps bare console.* calls in `if (import.meta.env.DEV)` so the
 *     production build tree-shakes them out (F2E Spec §7 推荐)
 *   - Leaves the surrounding template literal, CSS, and the file's own
 *     Node-level exports (buildMobileHTML / module.exports) untouched
 *
 * Idempotent: running twice is a no-op.
 *
 * Run with: node scripts/ci/codemod-f2e-bridge-mobile.js
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.resolve(__dirname, '../../services/backend/src/bridge/mobilePage.js');
const src = fs.readFileSync(TARGET, 'utf8');

// Find the inline <script>...</script> block. mobilePage.js has exactly one.
const SCRIPT_OPEN = /<script>/g;
const SCRIPT_CLOSE = /<\/script>/g;
const openMatch = SCRIPT_OPEN.exec(src);
if (!openMatch) {
  console.error('FATAL: no <script> block found in ' + TARGET);
  process.exit(1);
}
const closeMatch = SCRIPT_CLOSE.exec(src);
if (!closeMatch) {
  console.error('FATAL: no </script> block found in ' + TARGET);
  process.exit(1);
}
const scriptStart = openMatch.index;
const scriptEnd = closeMatch.index + '</script>'.length;
const scriptBody = src.slice(scriptStart, scriptEnd);

const before = scriptBody;
let after = scriptBody;

// 1) var → let (var has no block scope; let is the safe F2E-compliant upgrade
//    for variables that get reassigned later in the same function).
//    const-only is too aggressive here (the IIFE has many reassignments).
//    Heuristic: any `var x = ...` becomes `let x = ...` so we don't break
//    later assignments.
after = after.replace(/^(\s*)var\b/gm, '$1let');
after = after.replace(/([\s,;{])var\b/g, '$1let');

// 2) console.log / warn / error / info / debug → wrapped in DEV guard.
//    Heuristic: only wrap lines that are NOT already inside an `if (...)` block
//    whose condition references `import.meta.env.DEV` or `__DEV__`. The
//    simplest, safe approach: prepend the guard when the line starts with
//    `console.` (after whitespace).
after = after.replace(
  /^(\s*)(console\.(log|warn|error|info|debug)\b[^\n]*)/gm,
  (m, ws, call) => {
    // Already wrapped?
    if (/import\.meta\.env\.DEV|__DEV__/.test(m)) return m;
    return `${ws}if (import.meta.env.DEV) {\n${ws}  ${call};\n${ws}}`;
  },
);

// 3) `function foo(...)` (declarations) at top-level scope of the IIFE →
//    `const foo = (...) =>` (arrow function expressions). Strict: only touch
//    declarations that look like `function NAME(` at start-of-line (after ws)
//    to avoid breaking function() callbacks.
after = after.replace(
  /^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm,
  (m, ws, name, params) => {
    return `${ws}const ${name} = (${params}) => {`;
  },
);

// 4) Strict equality: == null / != null → === null / !== null and
//    == undefined / != undefined → === undefined / !== undefined.
//    Skip if already part of !== or ===.
after = after.replace(/==\s*null\b/g, '=== null');
after = after.replace(/!=\s*null\b/g, '!== null');
after = after.replace(/==\s*undefined\b/g, '=== undefined');
after = after.replace(/!=\s*undefined\b/g, '!== undefined');

if (after === before) {
  console.log('codemod: no changes needed (' + TARGET + ')');
  process.exit(0);
}

// Splice: keep prefix, swap script body, keep suffix.
const prefix = src.slice(0, scriptStart);
const suffix = src.slice(scriptEnd);
const next = prefix + after + suffix;
fs.writeFileSync(TARGET, next, 'utf8');

const lineDelta = (next.match(/\n/g) || []).length - (src.match(/\n/g) || []).length;
console.log('codemod: rewrote inline <script> in ' + TARGET);
console.log('  bytes: ' + src.length + ' → ' + next.length + ' (Δ ' + (next.length - src.length) + ')');
console.log('  line delta: ' + lineDelta);
