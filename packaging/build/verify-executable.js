'use strict';

/**
 * Smoke-test generated executables.
 *
 * Verifies that each executable:
 *   1. Exists at the expected path
 *   2. Has reasonable file size (> 1MB, < 200MB)
 *   3. Runs --version or --help without crashing
 *
 * Usage:
 *   node packaging/build/verify-executable.js
 *   node packaging/build/verify-executable.js --module khy-ai
 *   node packaging/build/verify-executable.js --platform win-x64
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const MODULES_JSON = path.join(ROOT, 'packaging/modules/modules.json');
const DIST_EXECUTABLES = path.join(ROOT, 'dist/executables');

const catalog = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));

const args = process.argv.slice(2);
const moduleFilter = (() => {
  const idx = args.indexOf('--module');
  return idx !== -1 ? args[idx + 1] : null;
})();
const platformFilter = (() => {
  const idx = args.indexOf('--platform');
  return idx !== -1 ? args[idx + 1] : null;
})();

const EXTENSIONS = {
  'win-x64': '.exe',
  'linux-x64': '',
  'macos-x64': '',
  'macos-arm64': '',
};

const MIN_SIZE = 1 * 1024 * 1024;       // 1 MB
const MAX_SIZE = 200 * 1024 * 1024;     // 200 MB

/**
 * Test a single executable.
 */
function verifyExecutable(moduleDef, platform) {
  const ext = EXTENSIONS[platform] || '';
  // Names carry a platform suffix (see pack-executable.js) so that release
  // uploads from different platforms never collide.
  const exePath = path.join(DIST_EXECUTABLES, platform, `${moduleDef.id}-${platform}${ext}`);
  const results = { module: moduleDef.id, platform, checks: [] };

  // Check 1: existence
  if (!fs.existsSync(exePath)) {
    results.checks.push({ name: 'exists', pass: false, detail: 'File not found' });
    return results;
  }
  results.checks.push({ name: 'exists', pass: true });

  // Check 2: file size
  const stat = fs.statSync(exePath);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
  if (stat.size < MIN_SIZE) {
    results.checks.push({ name: 'size', pass: false, detail: `Too small: ${sizeMB} MB (min 1 MB)` });
  } else if (stat.size > MAX_SIZE) {
    results.checks.push({ name: 'size', pass: false, detail: `Too large: ${sizeMB} MB (max 200 MB)` });
  } else {
    results.checks.push({ name: 'size', pass: true, detail: `${sizeMB} MB` });
  }

  // Check 3: execution test (only on matching platform)
  const currentPlatform = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === currentPlatform) {
    results.checks.push({ name: 'run', pass: null, detail: 'pending' });
  } else {
    results.checks.push({ name: 'run', pass: null, detail: `Skipped (cross-platform: ${platform})` });
  }

  return results;
}

/**
 * Run execution test (async).
 */
function runExecutionTest(exePath) {
  return new Promise((resolve) => {
    execFile(exePath, ['--help'], { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ pass: false, detail: 'Timed out (10s)' });
      } else if (error && error.code !== 0) {
        // Some tools exit non-zero for --help, that's OK if they produce output
        if (stdout || stderr) {
          resolve({ pass: true, detail: `Exit ${error.code} with output` });
        } else {
          resolve({ pass: false, detail: `Exit ${error.code}, no output` });
        }
      } else {
        resolve({ pass: true, detail: 'OK' });
      }
    });
  });
}

// ── Main ──
async function main() {
  console.log('\n  Verifying executables...\n');

  let modules = catalog.modules;
  if (moduleFilter) modules = modules.filter(m => m.id === moduleFilter);

  const platforms = platformFilter ? [platformFilter] : Object.keys(EXTENSIONS);
  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;

  for (const mod of modules) {
    for (const platform of platforms) {
      if (!mod.platforms.includes(platform)) continue;

      const result = verifyExecutable(mod, platform);
      const label = `${mod.id}/${platform}`;

      for (const check of result.checks) {
        if (check.pass === true) {
          console.log(`  ✓ ${label} [${check.name}] ${check.detail || ''}`);
          totalPass++;
        } else if (check.pass === false) {
          console.log(`  ✗ ${label} [${check.name}] ${check.detail}`);
          totalFail++;
        } else {
          // Run test if applicable
          if (check.name === 'run' && check.detail === 'pending') {
            const ext = EXTENSIONS[platform] || '';
            const exePath = path.join(DIST_EXECUTABLES, platform, `${mod.id}-${platform}${ext}`);
            const runResult = await runExecutionTest(exePath);
            if (runResult.pass) {
              console.log(`  ✓ ${label} [run] ${runResult.detail}`);
              totalPass++;
            } else {
              console.log(`  ✗ ${label} [run] ${runResult.detail}`);
              totalFail++;
            }
          } else {
            console.log(`  ⊘ ${label} [${check.name}] ${check.detail}`);
            totalSkip++;
          }
        }
      }
    }
  }

  console.log(`\n  Results: ${totalPass} passed, ${totalFail} failed, ${totalSkip} skipped\n`);

  if (totalFail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
