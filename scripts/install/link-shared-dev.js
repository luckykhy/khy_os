#!/usr/bin/env node
'use strict';

/**
 * link-shared-dev.js — root `preinstall` hook (dev-only, idempotent, never fatal).
 *
 * `services/backend` declares `"@khy/shared": "file:./vendor/shared"` so the
 * PUBLISHED tarball is self-contained (prepack.js copies the workspace package
 * into vendor/shared at pack time). In a monorepo CHECKOUT that `file:` target
 * must also exist, or npm resolves it against a missing directory and leaves a
 * dangling `node_modules/@khy/shared` — the `Cannot find module .../@khy/shared/...`
 * failure.
 *
 * This hook bridges the two worlds without touching the published contract: it
 * points vendor/shared at the live workspace source via a relative symlink, so
 * the backend reads the canonical package with zero snapshot drift, and npm's
 * `file:` resolution finds a valid target before it builds the dependency tree.
 * It runs as the root `preinstall`, i.e. BEFORE workspace dependency resolution,
 * which is the only point early enough to satisfy a `file:` target.
 *
 * It is a strict no-op outside a dev checkout (the workspace source is absent on
 * an end-user `npm i -g khy-os-backend`, where vendor/shared is already a real
 * copy from the tarball), and it never throws — any failure (e.g. Windows symlink
 * privileges) degrades to a warning so it can never block an install. prepack.js
 * still `rm`s and replaces vendor/shared with a real copy at pack time, so this
 * symlink never leaks into a published artifact.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARED_SRC = path.join(REPO_ROOT, 'platform', 'packages', 'shared');
const VENDOR_DIR = path.join(REPO_ROOT, 'services', 'backend', 'vendor');
const VENDOR_SHARED = path.join(VENDOR_DIR, 'shared');

function log(msg) { process.stdout.write(`[link-shared-dev] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[link-shared-dev] ${msg}\n`); }

function alreadyLinked() {
  try {
    if (!fs.lstatSync(VENDOR_SHARED).isSymbolicLink()) return false;
    return fs.realpathSync(VENDOR_SHARED) === fs.realpathSync(SHARED_SRC);
  } catch {
    return false;
  }
}

/**
 * 这个 hook 是否有权删除 vendor/shared：只有它自己建的符号链接才算。
 * 真目录一律不碰——那是被 git 跟踪的源码，可能还带着未提交的修改。
 */
function isSelfMadeLink() {
  try {
    return fs.lstatSync(VENDOR_SHARED).isSymbolicLink();
  } catch {
    return false;
  }
}

function main() {
  // Only act inside a monorepo checkout; on an end-user install the workspace
  // source is absent and vendor/shared is the real copy shipped in the tarball.
  if (!fs.existsSync(path.join(SHARED_SRC, 'package.json'))) return;

  if (alreadyLinked()) return; // idempotent

  // NEVER destroy a tracked working tree. vendor/shared is NOT git-ignored in this
  // repo — `git ls-files` reports 87 tracked files under it, and some of them can
  // carry uncommitted edits. The original `rmSync` here assumed vendor/ existed
  // only at pack time; that assumption is false, and acting on it would delete
  // real source (including unstaged work) on any plain `npm install`.
  //
  // So: replace only what this hook is entitled to replace — a missing target, or
  // a symlink it previously created. A real directory is left exactly as it is.
  // A checked-in vendor/shared already satisfies the `file:` dependency, which is
  // the only thing this hook exists to guarantee, so bailing out is not a
  // degradation — the install resolves fine either way.
  if (fs.existsSync(VENDOR_SHARED)) {
    if (!isSelfMadeLink()) {
      log('vendor/shared is a real directory (tracked in git); leaving it untouched');
      return;
    }
    fs.rmSync(VENDOR_SHARED, { recursive: true, force: true });
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const relTarget = path.relative(VENDOR_DIR, SHARED_SRC);
  fs.symlinkSync(relTarget, VENDOR_SHARED, 'dir');
  log(`linked vendor/shared → ${relTarget}`);
}

try {
  main();
} catch (err) {
  // Never block an install: degrade to a warning (e.g. Windows symlink perms).
  warn(`skipped (${err && err.message ? err.message : err}); run \`npm run setup\` if @khy/shared fails to resolve`);
}
