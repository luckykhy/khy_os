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
  // Native / dynamic-load addons that esbuild cannot bundle. Native bindings
  // must resolve at runtime; the pure JS surface we depend on is small enough
  // that the runtime require is cheap.
  'sqlite3',
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
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

const banner = `/* KHY OS Backend v${pkg.version} | ${new Date().toISOString().split('T')[0]} */\n`;
// Note: shebang is auto-prepended by esbuild on every entry-point output.
// Adding one in banner.js produces a duplicate shebang (`#!\n#!`) that Node
// CJS loader rejects with "Invalid or unexpected token". The version stamp
// sits on line 2 (or 3 if the auto-shebang precedes it).

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
// CLI entry point — the production startup path (DESIGN-PERF-001 v1 §阶段 A).
// esbuild auto-prepends the `#!` shebang; the banner.js string supplies only
// the version stamp on line 2. Invoke via `node dist/cli.cjs` from the
// portable install (or rely on `bin/khy.js` falling back to source when
// KHY_NO_BUNDLE=1).
  {
    ...sharedOptions,
    entryPoints: ['bin/khy.js'],
    outfile: 'dist/cli.cjs',
    format: 'cjs',
    minify: isProd,
    minifyWhitespace: isProd,
    minifyIdentifiers: false, // Keep identifiers readable for debugging
    minifySyntax: isProd,
    banner: {
      js: banner,
    },
    define: {
      ...sharedOptions.define,
      'process.env.KHY_BUNDLED_CLI': '"true"',
    },
  },
  // CLI minified ESM bundle (DESIGN-PERF-001 v1 §阶段 A — DISABLED).
// esbuild's ESM output translates every CJS `require()` into a dynamic
// `require()` stub that Node's ESM loader refuses to satisfy at runtime
// (Error: Dynamic require of "path" is not supported). khy's source code is
// 99% CJS with module-level requires; ESM bundling is not viable without
// rewriting the require graph. The CommonJS `dist/cli.cjs` target above
// remains the production startup path — invoke as `node dist/cli.cjs` or
// rely on the source fallback (`bin/khy.js`). The KHY_NO_BUNDLE gate in
// bin/khy.js detects both files and prefers the .cjs bundle.
// Original ESM config retained below for future re-evaluation once the
// require graph is converted to ESM-aware imports.
//   {
//     entryPoints: ['bin/khy.js'],
//     outfile: 'dist/cli.mjs',
//     format: 'esm',
//     minify: ...,
//     external: [...externalDeps, 'ink', 'react'],
//     define: { ...sharedOptions.define, 'process.env.KHY_BUNDLED_CLI': '"true"' },
//   },
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
