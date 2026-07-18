#!/usr/bin/env node
'use strict';

/**
 * prepack.js — npm `prepack` hook for the `khy-os-backend` package.
 *
 * Runs automatically on `npm pack` / `npm publish`. It makes the published
 * tarball self-contained and adds full-source-restore capability:
 *
 *   1. Vendor @khy/shared:  copy platform/packages/shared → vendor/shared so the
 *      `"@khy/shared": "file:./vendor/shared"` dependency resolves on the user's
 *      machine (the monorepo workspace is not present after `npm i -g`).
 *   2. Embed encrypted source snapshot:  run makeSourceSnapshot.js → _source/, so
 *      `khy restore` can reconstruct the entire project on any machine.
 *
 * Safety: the snapshot step needs git + KHY_SOURCE_PUBLISH_SECRET; without them
 * the generator warns and writes nothing (never ships plaintext). Vendoring is
 * best-effort-with-loud-failure: a missing shared package aborts the pack so we
 * never publish a broken dependency graph.
 *
 * Both `files` allowlist (package.json) and this hook are required: the allowlist
 * keeps `.env`/tests out of the tarball; this hook puts vendor/ + _source/ in.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');          // services/backend
const REPO_ROOT = path.resolve(BACKEND_DIR, '..', '..');    // monorepo root
const SHARED_SRC = path.join(REPO_ROOT, 'platform', 'packages', 'shared');
const VENDOR_SHARED = path.join(BACKEND_DIR, 'vendor', 'shared');

function log(msg) { process.stdout.write(`[prepack] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[prepack] ${msg}\n`); }

/** Copy platform/packages/shared → vendor/shared (source/config only). */
const VENDOR_SKIP = new Set([
  'node_modules', '.git', 'logs', '.tmp', 'temp', 'tmp',
  'coverage', '.cache', '.nyc_output', 'dist', 'build', '__pycache__',
]);

function vendorShared() {
  if (!fs.existsSync(path.join(SHARED_SRC, 'package.json'))) {
    throw new Error(`找不到共享包源: ${SHARED_SRC}`);
  }
  fs.mkdirSync(path.dirname(VENDOR_SHARED), { recursive: true });
  fs.rmSync(VENDOR_SHARED, { recursive: true, force: true });
  fs.cpSync(SHARED_SRC, VENDOR_SHARED, {
    recursive: true,
    force: true,
    // Skip runtime junk (logs can reach hundreds of MB) and large caches.
    filter: (src) => !VENDOR_SKIP.has(path.basename(src)),
  });
  log(`vendored @khy/shared → ${path.relative(BACKEND_DIR, VENDOR_SHARED)}`);
}

/** Run the encrypted source-snapshot generator into _source/. */
function embedSourceSnapshot() {
  const script = path.join(BACKEND_DIR, 'scripts', 'makeSourceSnapshot.js');
  const outDir = path.join(BACKEND_DIR, '_source');
  const args = ['--out', outDir, '--root', REPO_ROOT];
  if (process.env.KHY_BUILD_TIMESTAMP) {
    args.push('--timestamp', process.env.KHY_BUILD_TIMESTAMP);
  }
  // The generator itself reads KHY_SOURCE_PUBLISH_SECRET / KHY_OWNER_SECRET and
  // warns+skips when absent, so this never breaks a plain `npm pack`.
  const result = spawnSync('node', [script, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.error) warn(`source snapshot generator error: ${result.error.message}`);
}

function main() {
  vendorShared();        // hard requirement — throws to abort the pack on failure
  embedSourceSnapshot(); // soft — warns and continues without a secret/git
}

main();
