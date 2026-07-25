/**
 * check-file-headers.js — Validates JSDoc file headers across src/
 *
 * Scans all .js files and reports which ones lack standard JSDoc headers.
 * Used as a code quality gate in CI/pre-commit.
 *
 * @module scripts/check-file-headers
 */
'use strict';

// ── Imports ──
const fs = require('fs');
const path = require('path');

// ── Configuration ──
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const PASS_THRESHOLD = 50; // coverage percentage required to pass

// ── Helpers ──

/**
 * Recursively collect all .js files under a directory.
 * @param {string} dir - Directory to scan
 * @returns {string[]} Array of absolute file paths
 */
function collectJsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      results.push(...collectJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Check whether a file starts with a JSDoc comment block.
 * Allows leading whitespace/blank lines and 'use strict' after the block.
 * @param {string} filePath - Absolute path to the file
 * @returns {boolean} True if the file has a JSDoc header
 */
function hasJsDocHeader(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  // Trim leading whitespace/blank lines
  const trimmed = content.trimStart();
  return trimmed.startsWith('/**');
}

// ── Main ──

function main() {
  const allFiles = collectJsFiles(SRC_DIR);
  const total = allFiles.length;

  if (total === 0) {
    console.log('No .js files found in src/');
    process.exit(0);
  }

  const missing = [];
  const withHeader = [];

  for (const file of allFiles) {
    if (hasJsDocHeader(file)) {
      withHeader.push(file);
    } else {
      missing.push(file);
    }
  }

  const coveragePercent = ((withHeader.length / total) * 100).toFixed(1);

  // ── Output ──
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  JSDoc File Header Check');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  if (missing.length > 0) {
    console.log(`  Files missing JSDoc header (${missing.length}):`);
    console.log('');
    for (const file of missing) {
      const relative = path.relative(path.resolve(__dirname, '..'), file);
      console.log(`    ✗ ${relative}`);
    }
    console.log('');
  }

  console.log('───────────────────────────────────────────────────');
  console.log(`  Total files:    ${total}`);
  console.log(`  With header:    ${withHeader.length}`);
  console.log(`  Missing header: ${missing.length}`);
  console.log(`  Coverage:       ${coveragePercent}%`);
  console.log('───────────────────────────────────────────────────');

  const pass = parseFloat(coveragePercent) >= PASS_THRESHOLD;
  if (pass) {
    console.log(`  ✓ PASS (threshold: ${PASS_THRESHOLD}%)`);
  } else {
    console.log(`  ✗ FAIL (threshold: ${PASS_THRESHOLD}%, actual: ${coveragePercent}%)`);
  }
  console.log('');

  process.exit(pass ? 0 : 1);
}

main();
