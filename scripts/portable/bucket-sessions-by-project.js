#!/usr/bin/env node
'use strict';

/**
 * bucket-sessions-by-project.js
 *
 * Migrate flat session files into per-project buckets, matching the new
 * layout in services/backend/src/services/sessionPersistence.js:
 *
 *   sessions/<id>.{json,jsonl,checkpoint.json}
 *     ->
 *   sessions/<encoded-cwd>/<id>.{json,jsonl,checkpoint.json}
 *
 * The bucket is derived from each snapshot's metadata.cwd. Snapshots with no
 * recorded cwd go into the shared "_unknown" bucket. The encoding mirrors the
 * runtime (_encodeProject): cwd.replace(/[^a-zA-Z0-9]/g, '-').
 *
 * Behavior:
 *   - Default: DRY-RUN (prints planned moves only).
 *   - --apply : actually move files and refresh the search index.
 *   - Existing destination files are never overwritten (skipped, source kept).
 *   - Idempotent: a second --apply run moves nothing.
 *
 * Usage:
 *   node scripts/bucket-sessions-by-project.js            # dry-run
 *   node scripts/bucket-sessions-by-project.js --apply
 */

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');

const BACKEND_SRC = path.join(__dirname, '..', '..', 'services', 'backend', 'src');
const { getProjectDataDir } = require(path.join(BACKEND_SRC, 'utils', 'dataHome'));

const UNKNOWN_BUCKET = '_unknown';
const SESSIONS_DIR = getProjectDataDir('sessions');

let moved = 0;
let skipped = 0;
let buckets = new Set();

function _encodeProject(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return UNKNOWN_BUCKET;
  const encoded = raw.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-');
  return encoded || UNKNOWN_BUCKET;
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
}

function _writeProjectMeta(bucketDir, cwd) {
  if (!cwd || !APPLY) return;
  try {
    const metaPath = path.join(bucketDir, '.project.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* new */ }
    meta.cwd = cwd;
    meta.updatedAt = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch { /* best effort */ }
}

function _moveFile(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    console.log(`[bucket]   SKIP (dest exists): ${path.basename(dest)}`);
    skipped++;
    return;
  }
  if (!APPLY) {
    console.log(`[bucket]   would move: ${path.basename(src)} -> ${path.relative(SESSIONS_DIR, dest)}`);
    moved++;
    return;
  }
  _ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
  moved++;
}

function main() {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`[bucket] mode=${mode}`);
  console.log(`[bucket] sessions=${SESSIONS_DIR}`);

  let entries;
  try {
    entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  } catch {
    console.log('[bucket] no sessions directory; nothing to do.');
    return;
  }

  // Only top-level flat *.json snapshots are candidates (skip dirs + jsonl/checkpoint).
  const flatSnapshots = entries
    .filter(e => e.isFile()
      && e.name.endsWith('.json')
      && !e.name.endsWith('.checkpoint.json')
      && e.name !== '.project.json')
    .map(e => e.name);

  if (flatSnapshots.length === 0) {
    console.log('[bucket] no flat snapshots to bucket; already organized.');
    return;
  }

  for (const snap of flatSnapshots) {
    const base = snap.replace(/\.json$/, '');
    const snapPath = path.join(SESSIONS_DIR, snap);

    let cwd = '';
    try {
      const data = JSON.parse(fs.readFileSync(snapPath, 'utf-8'));
      cwd = (data.metadata && data.metadata.cwd) || '';
    } catch { /* unreadable -> unknown bucket */ }

    const bucket = _encodeProject(cwd);
    buckets.add(bucket);
    const bucketDir = path.join(SESSIONS_DIR, bucket);
    _writeProjectMeta(bucketDir, cwd);

    for (const ext of ['.json', '.jsonl', '.checkpoint.json']) {
      _moveFile(path.join(SESSIONS_DIR, base + ext), path.join(bucketDir, base + ext));
    }
  }

  console.log(`[bucket] done: moved=${moved} skipped=${skipped} buckets=${buckets.size}`);

  if (APPLY) {
    try {
      const idx = require(path.join(BACKEND_SRC, 'services', 'sessionSearchIndex'));
      idx.init();
      const r = idx.reindexAll();
      console.log(`[bucket] reindex: ${JSON.stringify(r)}`);
    } catch (err) {
      console.log(`[bucket] reindex skipped: ${err && err.message}`);
    }
  } else {
    console.log('[bucket] DRY-RUN complete. Re-run with --apply to move.');
  }
}

main();
