'use strict';

/**
 * Multi-target esbuild configuration for modular packaging.
 *
 * Reads modules.json and dependency-map.json to generate per-module
 * esbuild builds with selective dependency exclusion and tree-shaking.
 *
 * Usage:
 *   node packaging/build/esbuild-modules.js                    # build all modules
 *   node packaging/build/esbuild-modules.js --module khy-ai    # build single module
 *   node packaging/build/esbuild-modules.js --prod             # production (minified)
 *   node packaging/build/esbuild-modules.js --analyze          # print metafile analysis
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// ── Paths ──
const ROOT = path.resolve(__dirname, '../..');
const BACKEND_ROOT = path.join(ROOT, 'services/backend');
const MODULES_JSON = path.join(ROOT, 'packaging/modules/modules.json');
const DEP_MAP_JSON = path.join(ROOT, 'packaging/build/dependency-map.json');
const DIST_ROOT = path.join(ROOT, 'dist/modules');

// ── Load configurations ──
const catalog = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
const depMap = JSON.parse(fs.readFileSync(DEP_MAP_JSON, 'utf8'));
const backendPkg = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'));

// ── CLI args ──
const args = process.argv.slice(2);
const isProd = args.includes('--prod') || args.includes('--production');
const isAnalyze = args.includes('--analyze');
const moduleFilter = (() => {
  const idx = args.indexOf('--module');
  return idx !== -1 ? args[idx + 1] : null;
})();

// ── Node built-ins to mark as external ──
const NODE_BUILTINS = [
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'url',
  'child_process', 'stream', 'events', 'util', 'assert', 'buffer',
  'querystring', 'readline', 'zlib', 'dns', 'dgram', 'cluster',
  'worker_threads', 'perf_hooks', 'inspector', 'v8', 'vm', 'tty',
  'string_decoder', 'module', 'constants',
].flatMap(m => [m, `node:${m}`]);

/**
 * Compute the external dependencies for a module.
 * Deps listed in excludeDeps are bundled out (marked external).
 * Deps NOT in excludeDeps are included in the bundle.
 */
function computeExternals(moduleConfig) {
  // All node built-ins are always external
  const externals = [...NODE_BUILTINS];

  // For the full 'khy' module, mark nothing as external (bundle everything possible)
  // For other modules, mark excluded deps as external
  if (moduleConfig.id !== 'khy') {
    for (const dep of moduleConfig.excludeDeps || []) {
      if (dep.endsWith('/*') || dep.endsWith('*')) {
        // Wildcard pattern like "@opentelemetry/*"
        const prefix = dep.replace(/\/?\*$/, '');
        // Find all matching packages from backend dependencies
        const allDeps = Object.keys(backendPkg.dependencies || {});
        for (const d of allDeps) {
          if (d.startsWith(prefix)) externals.push(d);
        }
      } else {
        externals.push(dep);
      }
    }
  }

  return [...new Set(externals)];
}

/**
 * Resolve the entry point path for a module.
 * The entry field in modules.json is relative to packaging/modules/entries/.
 */
function resolveEntry(moduleConfig) {
  const entryRelative = moduleConfig.entry;
  return path.resolve(ROOT, 'packaging/modules/entries', entryRelative);
}

/**
 * Build a single module.
 */
async function buildModule(moduleConfig) {
  const moduleId = moduleConfig.id;
  const outDir = path.join(DIST_ROOT, moduleId);

  // Ensure output directory
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const entryPoint = resolveEntry(moduleConfig);
  if (!fs.existsSync(entryPoint)) {
    console.error(`  \u2717 Entry not found: ${entryPoint}`);
    return null;
  }

  const externals = computeExternals(moduleConfig);
  const outfile = path.join(outDir, 'bundle.cjs');

  const config = {
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: catalog.nodeTarget || 'node22',
    format: 'cjs',
    external: externals,
    sourcemap: true,
    metafile: true,
    treeShaking: true,
    minify: isProd,
    minifyWhitespace: isProd,
    minifyIdentifiers: false, // Keep identifiers readable
    minifySyntax: isProd,
    logLevel: 'warning',
    banner: {
      js: `#!/usr/bin/env node\n/* KHY OS Module: ${moduleId} v${catalog.version} | ${new Date().toISOString().split('T')[0]} */`,
    },
    define: {
      'process.env.KHY_BUNDLED': '"true"',
      'process.env.KHY_MODULE': `"${moduleId}"`,
    },
  };

  try {
    const result = await esbuild.build(config);

    // Write metafile for analysis
    const metaPath = path.join(outDir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(result.metafile));

    // Report size
    const stat = fs.statSync(outfile);
    const sizeKB = (stat.size / 1024).toFixed(1);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`  \u2713 ${moduleId.padEnd(14)} ${sizeKB.padStart(10)} KB  (${sizeMB} MB)  \u2192 ${path.relative(ROOT, outfile)}`);

    // Print analysis if requested
    if (isAnalyze && result.metafile) {
      const text = await esbuild.analyzeMetafile(result.metafile, { verbose: false });
      console.log(text);
    }

    return result;
  } catch (err) {
    console.error(`  \u2717 ${moduleId}: ${err.message}`);
    return null;
  }
}

// ── Main ──
async function main() {
  const startTime = Date.now();

  // Filter modules
  let modules = catalog.modules;
  if (moduleFilter) {
    modules = modules.filter(m => m.id === moduleFilter);
    if (modules.length === 0) {
      console.error(`Module "${moduleFilter}" not found. Available: ${catalog.modules.map(m => m.id).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Building ${modules.length} module(s) (${isProd ? 'production' : 'development'})...\n`);

  // Ensure dist root
  if (!fs.existsSync(DIST_ROOT)) fs.mkdirSync(DIST_ROOT, { recursive: true });

  // Build modules sequentially to avoid resource contention
  const results = [];
  for (const mod of modules) {
    const result = await buildModule(mod);
    results.push({ id: mod.id, result });
  }

  const elapsed = Date.now() - startTime;
  const succeeded = results.filter(r => r.result !== null).length;
  const failed = results.filter(r => r.result === null).length;

  console.log(`\n  Done in ${elapsed}ms \u2014 ${succeeded} succeeded, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
