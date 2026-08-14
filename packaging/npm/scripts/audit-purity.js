#!/usr/bin/env node
'use strict';

/**
 * audit-purity.js — npm package purity/completeness audit for @khy-os/khy-os.
 *
 * Mirrors the pip channel's `build-and-audit-pip-purity.sh` philosophy:
 *   - No foreign dependency trees (node_modules, site-packages, …)
 *   - No compiled/build artifacts (.so, .dylib, .o, .bin, .elf, …)
 *   - Required package files must be present
 *
 * The npm channel publishes standalone executables under dist/executables/<platform>/.
 * This script audits that directory tree.
 *
 * Exit 0 on pass, 1 on first violation.
 *
 * Usage:
 *   node scripts/audit-purity.js [--dist-dir <path>] [--platform <name>]
 *
 *   --dist-dir   Root containing executables/ (default: dist)
 *   --platform   Only audit this platform (win-x64, linux-x64, macos-x64, macos-arm64)
 *                Default: audit all platforms found.
 */

const fs = require('fs');
const path = require('path');

// ── Forbidden directory basenames (foreign dep trees, build junk) ─────────────
const FORBIDDEN_DIRS = new Set([
  'node_modules', 'bower_components', '.pnpm-store', 'site-packages',
  '.venv', 'venv', '.tox', 'jspm_packages', '_build', 'target',
]);

// ── Forbidden file basenames / suffixes (compiled artifacts, secrets, junk) ────
const FORBIDDEN_FILE_GLOBS = [
  '*.o', '*.bin', '*.elf', '*.iso', '*.img', '*.so', '*.so.*', '*.dylib',
  '*.gguf', '*.safetensors', '*.onnx', '*.pt', '*.pth', '*.h5', '*.pkl',
  '*.key', '*.pem', '*.rar', '*.enc', '*.tar.gz',
  '.env', '.env.*',
];

// ── Required files that must ship in every platform's executables dir ──────────
const REQUIRED_EXECUTABLE_NAMES = [
  'khy-',
  // The npm channel publishes one executable per module; at minimum the
  // full-platform entrypoint must exist so `npx khy` works after install.
];

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const distDir = (() => {
    const i = args.indexOf('--dist-dir');
    return i !== -1 ? path.resolve(args[i + 1]) : path.resolve('dist');
  })();
  const platformFilter = (() => {
    const i = args.indexOf('--platform');
    return i !== -1 ? args[i + 1] : null;
  })();
  return { distDir, platformFilter };
}

function log(...a) { console.log('[audit:purity]', ...a); }
function fail(...a) { console.error('[audit:purity FAIL]', ...a); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function fnmatch(name, pattern) {
  // Minimal glob: * matches anything, ? matches one char
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\?/g, '.')
    .replace(/\*/g, '.*');
  return new RegExp(`^${re}$`).test(name);
}

function isForbiddenFile(name) {
  for (const g of FORBIDDEN_FILE_GLOBS) {
    if (fnmatch(name, g)) return true;
  }
  return false;
}

function checkDir(dir, label) {
  if (!fs.existsSync(dir)) {
    fail(`${label} not found: ${dir}`);
  }
  if (!fs.statSync(dir).isDirectory()) {
    fail(`${label} is not a directory: ${dir}`);
  }
}

// ── Audit a single platform directory ────────────────────────────────────────
function auditPlatform(execDir, platformName) {
  log(`Auditing platform: ${platformName} (${path.relative(process.cwd(), execDir)})`);

  // Required: at least one executable
  let entries = fs.readdirSync(execDir);
  if (entries.length === 0) {
    fail(`${platformName}: executables directory is empty — nothing to ship`);
  }

  // Forbidden dirs
  for (const e of entries) {
    const full = path.join(execDir, e);
    const stat = fs.statSync(full);
    if (stat.isDirectory() && FORBIDDEN_DIRS.has(e)) {
      fail(`${platformName}: contains forbidden directory: ${e}`);
    }
  }

  // Forbidden files (recursive)
  function walk(p) {
    const items = fs.readdirSync(p);
    for (const item of items) {
      const full = path.join(p, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (FORBIDDEN_DIRS.has(item)) {
          fail(`${platformName}: contains forbidden directory: ${path.relative(execDir, full)}`);
        }
        walk(full);
      } else {
        if (isForbiddenFile(item)) {
          fail(`${platformName}: contains forbidden file: ${path.relative(execDir, full)}`);
        }
      }
    }
  }
  walk(execDir);

  // Required: at least one file whose name starts with the expected prefix
  const hasExecutable = entries.some(e => REQUIRED_EXECUTABLE_NAMES.some(p => e.startsWith(p)));
  if (!hasExecutable) {
    fail(`${platformName}: no recognizable khy executable found in ${entries.join(', ')}`);
  }

  log(`  OK — ${platformName} is pure and complete`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const { distDir, platformFilter } = parseArgs();

  const executablesRoot = path.join(distDir, 'executables');
  checkDir(executablesRoot, 'executables root');

  let platforms = fs.readdirSync(executablesRoot);
  platforms = platforms.filter(p => {
    const full = path.join(executablesRoot, p);
    return fs.statSync(full).isDirectory();
  });

  if (platforms.length === 0) {
    fail('No platform directories found under dist/executables/');
  }

  if (platformFilter) {
    if (!platforms.includes(platformFilter)) {
      fail(`Platform "${platformFilter}" not found. Available: ${platforms.join(', ')}`);
    }
    platforms = [platformFilter];
  }

  for (const p of platforms) {
    auditPlatform(path.join(executablesRoot, p), p);
  }

  log('Purity audit passed: all platform outputs are isolated, complete, and dependency-free.');
}

try {
  main();
} catch (err) {
  if (err.code === 'ENOENT') {
    fail(`path not found: ${err.path} — ${err.message}`);
  }
  fail(err.message);
}
