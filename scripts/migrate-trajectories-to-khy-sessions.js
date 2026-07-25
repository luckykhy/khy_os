#!/usr/bin/env node
'use strict';

/**
 * migrate-trajectories-to-khy-sessions.js
 *
 * One-shot, idempotent migration that converges legacy conversation
 * trajectories from the old data root (~/.khyquant) into the new
 * ~/.khy/sessions store used by sessionPersistence (JSONL transcript +
 * JSON snapshot + search index).
 *
 * Sources scanned:
 *   - ~/.khyquant/conversations/*.json                      (global)
 *   - ~/.khyquant/projects/<hash>/conversations/*.json      (per-project)
 *
 * Behavior:
 *   - Default: DRY-RUN. Only prints what would be migrated.
 *   - --apply   : actually write to ~/.khy/sessions via persistSession.
 *   - --reindex : after applying, rebuild the full search index.
 *   - Source files are NEVER deleted.
 *
 * Idempotency:
 *   persistSession appends only the JSONL delta (existing line count vs.
 *   current message count), so re-running --apply on the same files does
 *   not duplicate transcript lines.
 *
 * Usage:
 *   node scripts/migrate-trajectories-to-khy-sessions.js            # dry-run
 *   node scripts/migrate-trajectories-to-khy-sessions.js --apply
 *   node scripts/migrate-trajectories-to-khy-sessions.js --apply --reindex
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SP_PATH = path.join(
  __dirname,
  '..',
  'services',
  'backend',
  'src',
  'services',
  'sessionPersistence',
);

const APPLY = process.argv.includes('--apply');
const REINDEX = process.argv.includes('--reindex');

const LEGACY_ROOT = path.join(os.homedir(), '.khyquant');

function _deriveSessionId(filePath, data) {
  const sid = String((data && data.sessionId) || '').trim();
  if (sid) return sid.replace(/[^a-zA-Z0-9_-]/g, '');
  // Stable id derived from the file path so re-runs map to the same session.
  const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return `legacy-${hash}`;
}

function _collectSources() {
  const files = [];

  // 1. Global conversations
  const globalDir = path.join(LEGACY_ROOT, 'conversations');
  if (fs.existsSync(globalDir)) {
    for (const f of fs.readdirSync(globalDir)) {
      if (f.endsWith('.json')) files.push(path.join(globalDir, f));
    }
  }

  // 2. Per-project conversations
  const projectsDir = path.join(LEGACY_ROOT, 'projects');
  if (fs.existsSync(projectsDir)) {
    for (const hash of fs.readdirSync(projectsDir)) {
      const convoDir = path.join(projectsDir, hash, 'conversations');
      if (!fs.existsSync(convoDir)) continue;
      for (const f of fs.readdirSync(convoDir)) {
        if (f.endsWith('.json')) files.push(path.join(convoDir, f));
      }
    }
  }

  return files;
}

function main() {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`[migrate-sessions] mode=${mode} legacyRoot=${LEGACY_ROOT}`);

  let sp = null;
  if (APPLY) {
    try {
      sp = require(SP_PATH);
    } catch (err) {
      console.error('[migrate-sessions] failed to load sessionPersistence:', err.message);
      process.exit(1);
    }
  }

  const files = _collectSources();
  console.log(`[migrate-sessions] found ${files.length} legacy conversation file(s)`);

  let migrated = 0, skipped = 0, totalMessages = 0;

  for (const filePath of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`[migrate-sessions]   SKIP (unreadable): ${filePath}`);
      skipped++;
      continue;
    }

    const messages = Array.isArray(data.messages) ? data.messages : [];
    if (messages.length === 0) {
      skipped++;
      continue;
    }

    const sessionId = _deriveSessionId(filePath, data);
    totalMessages += messages.length;

    if (!APPLY) {
      console.log(`[migrate-sessions]   would migrate ${messages.length} msg -> ${sessionId}`);
      migrated++;
      continue;
    }

    try {
      sp.persistSession(sessionId, {
        messages,
        model: data.model || '',
        metadata: {
          cwd: data.cwd || '',
          migratedFrom: filePath,
          originalTimestamp: data.timestamp || '',
        },
        createdAt: data.timestamp ? Date.parse(data.timestamp) || undefined : undefined,
      });
      migrated++;
    } catch (err) {
      console.warn(`[migrate-sessions]   FAILED ${sessionId}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`[migrate-sessions] done: migrated=${migrated} skipped=${skipped} messages=${totalMessages}`);

  if (APPLY && REINDEX) {
    try {
      const idxPath = path.join(__dirname, '..', 'services', 'backend', 'src', 'services', 'sessionSearchIndex');
      const idx = require(idxPath);
      idx.init();
      const r = idx.reindexAll();
      console.log(`[migrate-sessions] reindex: indexed=${r.indexed} total=${r.total}`);
    } catch (err) {
      console.warn('[migrate-sessions] reindex failed:', err.message);
    }
  }

  if (!APPLY) {
    console.log('[migrate-sessions] DRY-RUN complete. Re-run with --apply to write. Source files are never deleted.');
  }
}

main();
