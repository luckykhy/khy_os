'use strict';

/**
 * Unified build entry — orchestrates esbuild bundling + pkg packaging.
 *
 * Usage:
 *   node packaging/build/build-all.js                         # build all, current platform
 *   node packaging/build/build-all.js --module khy-ai         # single module
 *   node packaging/build/build-all.js --platform win-x64      # specific platform
 *   node packaging/build/build-all.js --all-platforms         # all platforms
 *   node packaging/build/build-all.js --prod                  # production (minified)
 *   node packaging/build/build-all.js --bundle-only           # only esbuild, skip pkg
 *   node packaging/build/build-all.js --pack-only             # only pkg (assumes bundles exist)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '../..');
const ESBUILD_SCRIPT = path.join(__dirname, 'esbuild-modules.js');
const PACK_SCRIPT = path.join(__dirname, 'pack-executable.js');

// ── Parse args ──
const args = process.argv.slice(2);
const bundleOnly = args.includes('--bundle-only');
const packOnly = args.includes('--pack-only');

// Forward relevant args to sub-scripts
const forwardArgs = args.filter(a => !['--bundle-only', '--pack-only'].includes(a));

function run(script, extraArgs = []) {
  const allArgs = [script, ...forwardArgs, ...extraArgs];
  console.log(`  → node ${path.relative(ROOT, script)} ${forwardArgs.join(' ')}`);
  execFileSync(process.execPath, allArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
}

// ── Main ──
function main() {
  const startTime = Date.now();

  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   Khy OS Modular Build Pipeline      ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  // Step 1: esbuild bundling
  if (!packOnly) {
    console.log('  ── Step 1/2: Bundling with esbuild ──\n');
    run(ESBUILD_SCRIPT);
    console.log('');
  }

  // Step 2: pkg packaging
  if (!bundleOnly) {
    console.log('  ── Step 2/2: Packaging with pkg ──\n');
    // If no --module specified, pass --all to pack-executable
    const extraPackArgs = [];
    if (!args.includes('--module') && !args.includes('--all')) {
      extraPackArgs.push('--all');
    }
    run(PACK_SCRIPT, extraPackArgs);
    console.log('');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  Build pipeline complete in ${elapsed}s\n`);
}

try {
  main();
} catch (err) {
  if (err.status) {
    console.error(`\n  Build pipeline failed at step (exit code ${err.status})`);
  } else {
    console.error('\n  Build pipeline failed:', err.message);
  }
  process.exit(1);
}
