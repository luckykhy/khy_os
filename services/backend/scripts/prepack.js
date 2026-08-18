#!/usr/bin/env node
'use strict';

/**
 * prepack.js — npm `prepack` hook for the `khy-os-backend` package.
 *
 * Runs automatically on `npm pack` / `npm publish`. It vendors @khy/shared into
 * the package so the file dependency resolves after installation. Large immutable
 * payloads are published separately and acquired through payloadProvisioner.
 *
 * Safety: vendoring is a hard requirement. Any stale `_source/` from historical
 * prepack runs is removed so an install tarball cannot silently regain the payload.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..'); // services/backend
const REPO_ROOT = path.resolve(BACKEND_DIR, '..', '..'); // monorepo root
const SHARED_SRC = path.join(REPO_ROOT, 'platform', 'packages', 'shared');
const VENDOR_SHARED = path.join(BACKEND_DIR, 'vendor', 'shared');

function log(msg) {
  process.stdout.write(`[prepack] ${msg}\n`);
}

/** Copy platform/packages/shared → vendor/shared (source/config only). */
const VENDOR_SKIP = new Set([
  'node_modules',
  '.git',
  'logs',
  '.tmp',
  'temp',
  'tmp',
  'coverage',
  '.cache',
  '.nyc_output',
  'dist',
  'build',
  '__pycache__',
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

function main() {
  vendorShared();
  fs.rmSync(path.join(BACKEND_DIR, '_source'), { recursive: true, force: true });
  log('on-demand source payload stays outside the npm package');
}

main();
