/**
 * @pattern Builder
 */
'use strict';

/**
 * esbuild configuration — bundle backend for production deployment.
 *
 * Produces:
 *   dist/khy.cjs     — CommonJS bundle (Node.js)
 *   dist/khy.mjs     — ESM bundle (modern runtimes)
 *
 * Features:
 *   - Tree-shaking of unused exports
 *   - External node_modules (not bundled)
 *   - Source maps for debugging
 *   - Minification for production
 *   - Banner with version info
 *
 * Usage:
 *   node esbuild.config.js          # development build
 *   node esbuild.config.js --prod   # production build (minified)
 *   node esbuild.config.js --watch  # watch mode
 *
 * @module esbuild.config
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const isProd = process.argv.includes('--prod') || process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

// Collect all direct dependencies to mark as external
const externalDeps = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
  // Node built-ins
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'url',
  'child_process', 'stream', 'events', 'util', 'assert', 'buffer',
  'querystring', 'readline', 'zlib', 'dns', 'dgram', 'cluster',
  'worker_threads', 'perf_hooks', 'inspector', 'v8', 'vm',
  'node:fs', 'node:path', 'node:os', 'node:crypto', 'node:http',
  'node:https', 'node:net', 'node:url', 'node:child_process',
  'node:stream', 'node:events', 'node:util', 'node:buffer',
  'node:readline', 'node:zlib', 'node:worker_threads',
];

const banner = `/* KHY OS Backend v${pkg.version} | ${new Date().toISOString().split('T')[0]} */`;

// ── Shared options ──

const sharedOptions = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: externalDeps,
  sourcemap: true,
  logLevel: 'info',
  metafile: true,
  treeShaking: true,
  banner: { js: banner },
  define: {
    'process.env.KHY_BUNDLED': '"true"',
  },
};

// ── Build configurations ──

const configs = [
  // CommonJS bundle
  {
    ...sharedOptions,
    entryPoints: ['src/index.js'],
    outfile: 'dist/khy.cjs',
    format: 'cjs',
    minify: isProd,
    minifyWhitespace: isProd,
    minifyIdentifiers: false, // Keep identifiers readable for debugging
    minifySyntax: isProd,
  },
  // ESM bundle
  {
    ...sharedOptions,
    entryPoints: ['src/index.js'],
    outfile: 'dist/khy.mjs',
    format: 'esm',
    minify: isProd,
    minifyWhitespace: isProd,
    minifyIdentifiers: false,
    minifySyntax: isProd,
  },
  // CLI entry point
  {
    ...sharedOptions,
    entryPoints: ['bin/khy.js'],
    outfile: 'dist/cli.cjs',
    format: 'cjs',
    minify: isProd,
    minifyWhitespace: isProd,
    minifyIdentifiers: false,
    minifySyntax: isProd,
    banner: {
      js: `#!/usr/bin/env node\n${banner}`,
    },
  },
];

// ── Main ──

async function build() {
  const startTime = Date.now();
  console.log(`\n  Building KHY OS Backend v${pkg.version} (${isProd ? 'production' : 'development'})...\n`);

  // Ensure dist directory
  if (!fs.existsSync('dist')) fs.mkdirSync('dist');

  if (isWatch) {
    // Watch mode — only build CJS
    const ctx = await esbuild.context(configs[0]);
    await ctx.watch();
    console.log('  Watching for changes...\n');
    return;
  }

  const results = [];

  for (const config of configs) {
    try {
      const result = await esbuild.build(config);
      results.push(result);

      // Print bundle size
      const outfile = config.outfile;
      const stat = fs.statSync(outfile);
      const sizeKB = (stat.size / 1024).toFixed(1);
      console.log(`  ${path.basename(outfile).padEnd(12)} ${sizeKB.padStart(8)} KB`);
    } catch (err) {
      console.error(`  Failed to build ${config.outfile}:`, err.message);
      process.exit(1);
    }
  }

  // Write metafile for analysis
  if (results[0] && results[0].metafile) {
    fs.writeFileSync('dist/meta.json', JSON.stringify(results[0].metafile));
  }

  const elapsed = Date.now() - startTime;
  console.log(`\n  Done in ${elapsed}ms\n`);

  // Print tree-shaking summary from metafile
  if (results[0] && results[0].metafile) {
    const meta = results[0].metafile;
    const inputs = Object.keys(meta.inputs).length;
    const outputs = Object.keys(meta.outputs);
    console.log(`  Inputs: ${inputs} files`);
    console.log(`  Outputs: ${outputs.length} files`);
  }
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
