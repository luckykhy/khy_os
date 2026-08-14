#!/usr/bin/env node
'use strict';

/**
 * relocate-khy-data-to-project-root.js
 *
 * One-shot, idempotent relocation that moves trajectory + memory data from the
 * user-level data home (~/.khy) into the KHY-OS project-scoped data home
 * (<project root>/.khy), matching the new resolution in
 * services/backend/src/utils/dataHome.js (getProjectDataHome).
 *
 * What is relocated:
 *   - ~/.khy/sessions/         -> <root>/.khy/sessions/        (JSONL + JSON)
 *   - ~/.khy/sessions.db[-wal|-shm] -> <root>/.khy/sessions.db (search index)
 *   - ~/.khy/memory/           -> <root>/.khy/memory/          (markdown + MEMORY.md)
 *
 * NOT relocated (these stay user-level on purpose):
 *   - settings / mcp / agents / audit / telemetry / gateway / plugins / etc.
 *
 * Behavior:
 *   - Default: DRY-RUN. Only prints what would move.
 *   - --apply : actually move files.
 *   - Existing destination files are NEVER overwritten (skipped, source kept).
 *   - After a successful move the (now-empty) source dirs are left in place;
 *     pass --prune to remove emptied source dirs.
 *
 * Usage:
 *   node scripts/relocate-khy-data-to-project-root.js            # dry-run
 *   node scripts/relocate-khy-data-to-project-root.js --apply
 *   node scripts/relocate-khy-data-to-project-root.js --apply --prune
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const APPLY = process.argv.includes('--apply');
const PRUNE = process.argv.includes('--prune');

const SRC_HOME = path.join(os.homedir(), '.khy');

function _projectDataHome() {
  const dataHome = require(path.join(
    __dirname, '..', '..', 'services', 'backend', 'src', 'utils', 'dataHome',
  ));
  return dataHome.getProjectDataHome();
}

let moved = 0;
let skipped = 0;
let missing = 0;

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
}

/** Move a single file src -> dest. Never overwrites an existing dest. */
function _moveFile(src, dest) {
  if (!fs.existsSync(src)) { missing++; return; }
  if (fs.existsSync(dest)) {
    console.log(`[relocate]   SKIP (dest exists): ${path.basename(dest)}`);
    skipped++;
    return;
  }
  if (!APPLY) {
    console.log(`[relocate]   would move: ${src} -> ${dest}`);
    moved++;
    return;
  }
  _ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // Cross-device or other rename failure: fall back to copy + unlink.
    if (err && (err.code === 'EXDEV')) {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
  moved++;
}

/** Move all entries (files) under srcDir into destDir. */
function _moveDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) { return; }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      _moveDir(src, dest);
    } else {
      _moveFile(src, dest);
    }
  }
  if (PRUNE && APPLY) {
    try {
      if (fs.readdirSync(srcDir).length === 0) {
        fs.rmdirSync(srcDir);
        console.log(`[relocate]   pruned empty dir: ${srcDir}`);
      }
    } catch { /* keep */ }
  }
}

function main() {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  const dstHome = _projectDataHome();
  console.log(`[relocate] mode=${mode}`);
  console.log(`[relocate] src=${SRC_HOME}`);
  console.log(`[relocate] dst=${dstHome}`);

  if (path.resolve(SRC_HOME) === path.resolve(dstHome)) {
    console.log('[relocate] src and dst are identical; nothing to do.');
    return;
  }

  // 1. sessions/ (trajectories: JSONL + JSON snapshots + checkpoints)
  _moveDir(path.join(SRC_HOME, 'sessions'), path.join(dstHome, 'sessions'));

  // 2. sessions.db + WAL/SHM sidecars (FTS5 search index)
  for (const name of ['sessions.db', 'sessions.db-wal', 'sessions.db-shm']) {
    _moveFile(path.join(SRC_HOME, name), path.join(dstHome, name));
  }

  // 3. memory/ (markdown memories + MEMORY.md index)
  _moveDir(path.join(SRC_HOME, 'memory'), path.join(dstHome, 'memory'));

  // 4. per-project memory (projects/<hash>/memory)
  const srcProjects = path.join(SRC_HOME, 'projects');
  if (fs.existsSync(srcProjects)) {
    for (const hash of fs.readdirSync(srcProjects)) {
      const srcMem = path.join(srcProjects, hash, 'memory');
      if (fs.existsSync(srcMem)) {
        _moveDir(srcMem, path.join(dstHome, 'projects', hash, 'memory'));
      }
    }
  }

  console.log(`[relocate] done: moved=${moved} skipped=${skipped} missing=${missing}`);
  if (!APPLY) {
    console.log('[relocate] DRY-RUN complete. Re-run with --apply to move.');
  }
}

main();
