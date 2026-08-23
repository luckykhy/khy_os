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
  rewriteBackendFallbacks();
  log(`vendored @khy/shared → ${path.relative(BACKEND_DIR, VENDOR_SHARED)}`);
}

/**
 * Re-anchor the backend fallback requires for the vendored copy's depth.
 *
 * platform/packages/shared sits five levels above the repo root, so its runtime
 * fallbacks into the backend are written as `../../../../../services/backend/...`.
 * Copied verbatim to services/backend/vendor/shared it is one level too deep AND
 * carries a `services/backend` segment that no longer exists below the package —
 * from the vendored location the same target is `../../../../...`.
 *
 * Left unrewritten the published tarball resolves the fallback to
 * `node_modules/services/backend/...`, which never exists, so the sqlite dialect
 * chain loses its last rung on any install without a native sqlite3. It fails at
 * first query, not at install, which is why it survived unnoticed.
 *
 * A vendored copy with zero rewrites would mean the anchor moved or the fallback
 * was dropped; either way the assumption behind this hook is gone, so throw
 * rather than publish a tarball whose fallback silently points at nothing.
 */
const BACKEND_ANCHOR_FROM = '../../../../../services/backend/';
const BACKEND_ANCHOR_TO = '../../../../';

function rewriteBackendFallbacks() {
  let rewrites = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const before = fs.readFileSync(abs, 'utf8');
      if (!before.includes(BACKEND_ANCHOR_FROM)) continue;
      const after = before.split(BACKEND_ANCHOR_FROM).join(BACKEND_ANCHOR_TO);
      fs.writeFileSync(abs, after);
      rewrites += 1;
      log(`re-anchored backend fallback → ${path.relative(VENDOR_SHARED, abs)}`);
    }
  };
  walk(VENDOR_SHARED);
  if (rewrites === 0) {
    throw new Error(
      `共享包里找不到任何 '${BACKEND_ANCHOR_FROM}' 回退引用；`
      + 'vendor/shared 的目录深度假设已失效，请先校对 prepack 再发布。'
    );
  }
}

function main() {
  vendorShared();
  fs.rmSync(path.join(BACKEND_DIR, '_source'), { recursive: true, force: true });
  log('on-demand source payload stays outside the npm package');
}

main();
