'use strict';

/**
 * Pack esbuild bundles into standalone executables using pkg.
 *
 * Prerequisites: esbuild-modules.js must have been run first.
 *
 * Usage:
 *   node packaging/build/pack-executable.js --module khy-ai --platform win-x64
 *   node packaging/build/pack-executable.js --module khy-ai --all-platforms
 *   node packaging/build/pack-executable.js --all
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const MODULES_JSON = path.join(ROOT, 'packaging/modules/modules.json');
const NATIVE_MODULES_JSON = path.join(__dirname, 'native-modules.json');
const DIST_MODULES = path.join(ROOT, 'dist/modules');
const DIST_EXECUTABLES = path.join(ROOT, 'dist/executables');

const catalog = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
const nativeConfig = JSON.parse(fs.readFileSync(NATIVE_MODULES_JSON, 'utf8'));

// ── Platform mapping ──
// Node target comes from modules.json (single source of truth). node20 base
// binaries are no longer published by pkg-fetch (Node 20 is EOL), so the
// catalog pins node22.
const NODE_TARGET = catalog.nodeTarget || 'node22';
const PLATFORM_TARGETS = {
  'win-x64': `${NODE_TARGET}-win-x64`,
  'linux-x64': `${NODE_TARGET}-linux-x64`,
  'macos-x64': `${NODE_TARGET}-macos-x64`,
  'macos-arm64': `${NODE_TARGET}-macos-arm64`,
};

const PLATFORM_EXTENSIONS = {
  'win-x64': '.exe',
  'linux-x64': '',
  'macos-x64': '',
  'macos-arm64': '',
};

// ── CLI args ──
const args = process.argv.slice(2);
const moduleFilter = (() => {
  const idx = args.indexOf('--module');
  return idx !== -1 ? args[idx + 1] : null;
})();
const platformFilter = (() => {
  const idx = args.indexOf('--platform');
  return idx !== -1 ? args[idx + 1] : null;
})();
const buildAll = args.includes('--all');
const allPlatforms = args.includes('--all-platforms');

/**
 * Resolve how to invoke pkg, as { bin, prefixArgs }.
 * Prefer running pkg's JS entry with the current Node binary: spawning
 * .cmd shims directly is rejected with EINVAL by Node >= 20 on Windows
 * (CVE-2024-27980 hardening). Supports both @yao-pkg/pkg (node20+ targets)
 * and legacy pkg installs.
 */
function getPkgInvocation() {
  const jsEntryCandidates = [
    'node_modules/@yao-pkg/pkg/lib-es5/bin.js',
    'node_modules/pkg/lib-es5/bin.js',
    'services/backend/node_modules/@yao-pkg/pkg/lib-es5/bin.js',
    'services/backend/node_modules/pkg/lib-es5/bin.js',
  ];
  for (const rel of jsEntryCandidates) {
    const candidate = path.join(ROOT, rel);
    if (fs.existsSync(candidate)) {
      return { bin: process.execPath, prefixArgs: [candidate] };
    }
  }
  // Fallback to a globally installed pkg (npm install -g @yao-pkg/pkg)
  if (process.platform === 'win32') {
    // .cmd shims must go through cmd.exe on Node >= 20 (spawn EINVAL otherwise)
    return { bin: 'cmd.exe', prefixArgs: ['/d', '/s', '/c', 'pkg'] };
  }
  return { bin: 'pkg', prefixArgs: [] };
}

/**
 * Build pkg configuration for a module + platform combination.
 */
function buildPkgConfig(moduleConfig, platform) {
  const moduleId = moduleConfig.id;
  const bundlePath = path.join(DIST_MODULES, moduleId, 'bundle.cjs');

  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Bundle not found: ${bundlePath}. Run esbuild-modules.js first.`);
  }

  const target = PLATFORM_TARGETS[platform];
  const ext = PLATFORM_EXTENSIONS[platform];
  const outputPath = path.join(DIST_EXECUTABLES, platform, `${moduleId}${ext}`);

  // Determine assets to include (native modules)
  const assets = [];
  for (const native of nativeConfig.modules) {
    // Only include if this module uses this native dep
    if (moduleConfig.excludeDeps && moduleConfig.excludeDeps.includes(native.package)) {
      continue; // Skip excluded native modules
    }
    if (native.assets) {
      for (const asset of native.assets) {
        const assetPath = path.join(ROOT, 'services/backend/node_modules', asset);
        if (fs.existsSync(assetPath)) {
          assets.push(assetPath);
        }
      }
    }
  }

  return { bundlePath, target, outputPath, assets };
}

/**
 * Execute pkg for a single module + platform.
 */
function packModule(moduleConfig, platform) {
  return new Promise((resolve, reject) => {
    const { bundlePath, target, outputPath, assets } = buildPkgConfig(moduleConfig, platform);

    // Ensure output directory
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const { bin, prefixArgs } = getPkgInvocation();
    const pkgArgs = [
      ...prefixArgs,
      bundlePath,
      '--target', target,
      '--output', outputPath,
      '--compress', 'GZip',
    ];

    // Add assets
    for (const asset of assets) {
      pkgArgs.push('--assets', asset);
    }

    console.log(`  Packaging ${moduleConfig.id} → ${platform}...`);

    execFile(bin, pkgArgs, {
      cwd: ROOT,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`  \u2717 ${moduleConfig.id}/${platform}: ${error.message}`);
        if (stderr) console.error(`    ${stderr.trim()}`);
        error.printed = true;
        reject(error);
        return;
      }

      // Report size
      if (fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
        console.log(`  ✓ ${moduleConfig.id}/${platform}  ${sizeMB} MB  → ${path.relative(ROOT, outputPath)}`);
      }

      resolve(outputPath);
    });
  });
}

// ── Main ──
async function main() {
  const startTime = Date.now();

  // Determine which modules to build
  let modules = catalog.modules;
  if (moduleFilter) {
    modules = modules.filter(m => m.id === moduleFilter);
    if (modules.length === 0) {
      console.error(`Module "${moduleFilter}" not found.`);
      process.exit(1);
    }
  } else if (!buildAll) {
    console.error('Specify --module <id> or --all');
    process.exit(1);
  }

  // Determine platforms
  let platforms;
  if (platformFilter) {
    if (!PLATFORM_TARGETS[platformFilter]) {
      console.error(`Unknown platform: ${platformFilter}. Available: ${Object.keys(PLATFORM_TARGETS).join(', ')}`);
      process.exit(1);
    }
    platforms = [platformFilter];
  } else if (allPlatforms) {
    platforms = Object.keys(PLATFORM_TARGETS);
  } else {
    // Default to current platform
    const current = `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
    platforms = [current];
  }

  console.log(`\n  Packing ${modules.length} module(s) × ${platforms.length} platform(s)...\n`);

  let succeeded = 0;
  let failed = 0;

  for (const mod of modules) {
    for (const platform of platforms) {
      // Check if module supports this platform
      if (!mod.platforms.includes(platform)) {
        console.log(`  ⊘ ${mod.id}/${platform} (not supported)`);
        continue;
      }
      try {
        await packModule(mod, platform);
        succeeded++;
      } catch (err) {
        // Sync throws (e.g. missing bundle, spawn EINVAL) are not printed by
        // the execFile callback, so surface them here for CI diagnostics.
        if (err && !err.printed) {
          console.error(`  \u2717 ${mod.id}/${platform}: ${err.message}`);
        }
        failed++;
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n  Done in ${(elapsed / 1000).toFixed(1)}s — ${succeeded} succeeded, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Pack failed:', err);
  process.exit(1);
});
