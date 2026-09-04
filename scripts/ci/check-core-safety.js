#!/usr/bin/env node

'use strict';

/**
 * check-core-safety.js — Core safety pattern detector
 *
 * Detects systemic anti-patterns in core modules that lead to security
 * vulnerabilities, data leaks, and reliability issues.
 *
 * Patterns detected:
 *   1. Insecure fallback: try { secure() } catch { insecure() }
 *   2. Guard flag set before work completes
 *   3. Unescaped user input in RegExp constructor
 *   4. Sensitive data in trace/log calls
 *   5. Unbounded Map/Set growth (no eviction)
 *
 * Usage: node scripts/ci/check-core-safety.js [--fix]
 */

const fs = require('fs');
const path = require('path');

const repoRoot = process.env.KHY_REPO_LAYOUT_ROOT
  ? path.resolve(process.env.KHY_REPO_LAYOUT_ROOT)
  : path.resolve(__dirname, '..', '..');

const findings = [];
let exitCode = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function walkDir(dir, results = []) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'build', '.git', '__tests__', 'test', 'tests', 'domain'].includes(entry.name)) continue;
        walkDir(path.join(dir, entry.name), results);
      } else if (entry.name.endsWith('.js')) {
        results.push(path.join(dir, entry.name));
      }
    }
  } catch {}
  return results;
}

function addFinding(severity, rule, file, line, message) {
  findings.push({ severity, rule, file: path.relative(repoRoot, file), line, message });
  if (severity === 'CRITICAL' || severity === 'HIGH') exitCode = 1;
}

// ── Rule 1: Insecure fallback pattern ──────────────────────────────────────
// Pattern: try { secureCall() } catch { directExecute() }
// This silently degrades security when the secure path throws.

function checkInsecureFallback() {
  const scanDirs = ['services/backend/src/services', 'services/backend/src/tools'];
  const insecurePatterns = [
    /tool\.execute\(/,           // direct tool execution without permission
    /toolRegistry\.execute\(/,   // registry execute without permission
    /\.execute\s*\(\s*p\s*,/,   // generic execute with params
  ];

  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of walkDir(fullDir)) {
      const content = fs.readFileSync(file, 'utf8');
      // Match: } catch { ... tool.execute( or toolRegistry.execute(
      const catchBlocks = content.match(/}\s*catch\s*(\([^)]*\)\s*)?\{[\s\S]{0,500}?\n\s*\}/g) || [];
      
      for (const block of catchBlocks) {
        for (const pattern of insecurePatterns) {
          if (pattern.test(block)) {
            // Find the line number
            const idx = content.indexOf(block);
            const line = content.substring(0, idx).split('\n').length;
            // Check if there's a MODULE_NOT_FOUND guard
            if (!block.includes('MODULE_NOT_FOUND') && !block.includes("err.code")) {
              addFinding('HIGH', 'insecure-fallback', file, line,
                'catch block falls back to direct tool execution without permission checks. ' +
                'Add `if (err.code === \'MODULE_NOT_FOUND\')` guard.');
            }
          }
        }
      }
    }
  }
}

// ── Rule 2: Guard flag set before work completes ──────────────────────────
// Pattern: if (loaded) return; loaded = true; try { ... } catch { ... }
// Only flags when there are multiple try/catch or require() phases AFTER the flag.

function checkPrematureGuardFlag() {
  const scanDirs = ['services/backend/src/services', 'services/backend/src/tools'];

  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of walkDir(fullDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Look for: _loaded = true
        if (/^_loaded = true;?$/.test(line)) {
          const flagName = '_loaded';
          // Check if there's a guard check within the previous 5 lines
          let hasGuard = false;
          for (let j = Math.max(0, i - 5); j < i; j++) {
            if (lines[j].includes(flagName) && (lines[j].includes('if') || lines[j].includes('return'))) {
              hasGuard = true;
              break;
            }
          }
          if (!hasGuard) continue;

          // Count try/catch blocks and require() calls AFTER the flag in the same function
          let tryCount = 0;
          let braceDepth = 0;
          for (let j = i + 1; j < Math.min(lines.length, i + 100); j++) {
            const l = lines[j].trim();
            braceDepth += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length;
            if (braceDepth < 0) break; // left the function
            if (l.startsWith('try') || l.includes('require(')) tryCount++;
          }
          if (tryCount >= 2) {
            addFinding('HIGH', 'premature-guard-flag', file, i + 1,
              `\`${flagName}\` is set before ${tryCount} initialization phases. Move to end of function.`);
          }
        }
      }
    }
  }
}

// ── Rule 3: Unescaped user input in RegExp ────────────────────────────────
// Pattern: new RegExp(variable) or new RegExp(str.replace(...)) without escaping

function checkRegexInjection() {
  const scanDirs = ['services/backend/src'];

  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of walkDir(fullDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Pattern: new RegExp(something.replace(/\*/g, '.*'))
        // This is the dangerous glob-to-regex without escaping
        if (/new RegExp\([^)]*\.replace\(.*\*.*\)/.test(line)) {
          // Check if there's proper escaping before the replace
          const prevLines = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
          if (!prevLines.includes('\\[') && !prevLines.includes('escapeRegExp') && !prevLines.includes("replace(/[.")) {
            addFinding('HIGH', 'regex-injection', file, i + 1,
              'Glob-to-regex without escaping special chars. ' +
              'Escape `[.+?^${}()|[]\\\\]` before converting `*` to `.*`.');
          }
        }
        // Pattern: new RegExp(variable, ...) where variable is not a string literal
        if (/new RegExp\(\s*[a-zA-Z_$]/.test(line) && !/new RegExp\(\s*['"`]/.test(line)) {
          // Check if it's in a permission/rules context
          if (file.includes('permission') || file.includes('rules') || file.includes('deny')) {
            if (!line.includes('slice(0,') && !line.includes('MAX')) {
              addFinding('MEDIUM', 'regex-no-bound', file, i + 1,
                'User-supplied regex compiled without length bound. ' +
                'Add `.slice(0, 200)` to prevent ReDoS.');
            }
          }
        }
      }
    }
  }
}

// ── Rule 4: Sensitive data in trace/log ───────────────────────────────────
// Pattern: logging full prompt, message content, or API keys

function checkDataExposure() {
  const scanDirs = ['services/backend/src/services/gateway'];
  const sensitiveFields = ['\\bprompt\\b', '\\bmessages\\b', '\\bapiKey\\b', '\\bapi_key\\b', '\\bsecret\\b'];
  const logCalls = ['logEvent', 'log\\.info', 'log\\.debug', 'console\\.log', 'console\\.error', 'appendFileSync'];

  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of walkDir(fullDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check if this line is a log/trace call
        const isLogCall = logCalls.some(lc => new RegExp(lc).test(line));
        if (!isLogCall) continue;

        // Check if sensitive fields are used without truncation
        for (const field of sensitiveFields) {
          const re = new RegExp(field);
          if (re.test(line) && !line.includes('slice(') && !line.includes('Preview') && 
              !line.includes('truncate') && !line.includes('redact') && !line.includes('mask')) {
            // Check context — is it in an object literal being logged?
            const context = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
            if (context.includes('logEvent') || context.includes('appendFile')) {
              addFinding('MEDIUM', 'data-exposure', file, i + 1,
                `Sensitive field may be logged without redaction. Use `.slice(0, 200)` or a preview field.`);
            }
          }
        }
      }
    }
  }
}

// ── Rule 5: Unbounded Map growth ──────────────────────────────────────────
// Pattern: new Map() without size cap or eviction

function checkUnboundedCache() {
  const scanDirs = ['services/backend/src/services'];

  for (const dir of scanDirs) {
    const fullDir = path.join(repoRoot, dir);
    if (!fs.existsSync(fullDir)) continue;

    for (const file of walkDir(fullDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Pattern: this._xxxCache = new Map() or const cache = new Map()
        if (/=\s*new Map\(\)/.test(line) && (line.includes('Cache') || line.includes('cache'))) {
          // Check if there's a size cap within the next 5 lines
          const context = lines.slice(i, Math.min(lines.length, i + 5)).join('\n');
          if (!context.includes('_MAX') && !context.includes('maxSize') && !context.includes('size >') &&
              !context.includes('evict') && !context.includes('LRU')) {
            // Check if this Map is used with .set() later (confirming it grows)
            const rest = lines.slice(i).join('\n');
            const mapName = line.match(/(\w+)\s*=\s*new Map/);
            if (mapName && rest.includes(mapName[1] + '.set(')) {
              addFinding('LOW', 'unbounded-cache', file, i + 1,
                `Map cache without size cap or eviction policy. Add a size limit (e.g., 500 entries).`);
            }
          }
        }
      }
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log('Running core safety checks...\n');

  checkInsecureFallback();
  checkPrematureGuardFlag();
  checkRegexInjection();
  checkDataExposure();
  checkUnboundedCache();

  // Report
  const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings) {
    bySev[f.severity]++;
    const icon = { CRITICAL: '!!!', HIGH: '!!', MEDIUM: '!', LOW: '~' }[f.severity];
    console.log(`[${icon}] ${f.severity} [${f.rule}] ${f.file}:${f.line}`);
    console.log(`    ${f.message}\n`);
  }

  console.log(`\n${findings.length} finding(s): ${bySev.CRITICAL} critical, ${bySev.HIGH} high, ${bySev.MEDIUM} medium, ${bySev.low || bySev.LOW} low`);
  
  if (exitCode !== 0) {
    console.log('\nFAILED — fix HIGH/CRITICAL issues before merging.');
  } else {
    console.log('\nPASSED — no critical/high issues found.');
  }

  process.exit(exitCode);
}

main();
