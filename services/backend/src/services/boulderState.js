'use strict';

/**
 * boulderState.js — Cross-session checkpoint persistence for agentic harness.
 *
 * Saves/loads Ralph Loop progress to disk so an interrupted session can
 * resume from where it left off (within a 24-hour TTL window).
 *
 * Storage: <dataHome>/boulder/<md5(cwd)>.json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 4;
// Checkpoint retention. Configurable via KHY_BOULDER_TTL_HOURS (default 24h);
// values <= 0 are ignored and fall back to the default.
const TTL_MS = (() => {
  const h = parseFloat(process.env.KHY_BOULDER_TTL_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
})();
const MAX_USER_MESSAGE_LEN = 2000;
const MAX_TOOL_CALL_LOG_ENTRIES = 50;
const MAX_CONVERSATION_MESSAGES = 30;
const MAX_MESSAGE_CONTENT_LEN = 1500;
const MAX_CONTEXT_SUMMARY_LEN = 8000;
const MAX_CURRENT_MESSAGE_LEN = 4000;
const MAX_BOULDER_FILE_BYTES = 512 * 1024; // 512 KB hard cap
const MAX_SNAPSHOT_FILES = 200; // Max files in filesystem snapshot

// ── SQLite WAL backend ─────────────────────────────────────────────────
let _db = null;
let _stmts = {};
let _sqliteAvailable = false;

function _initSqlite() {
  if (_db) return _sqliteAvailable;
  try {
    const Database = require('better-sqlite3');
    const { getDataDir } = require('../utils/dataHome');
    const dbPath = path.join(getDataDir('boulder'), 'boulder.db');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        cwd_hash   TEXT PRIMARY KEY,
        cwd        TEXT NOT NULL,
        data       TEXT NOT NULL,
        schema_ver INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
        updated_at INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'in_progress'
      )
    `);
    // Migration: add task_id column so checkpoints are addressable by task id
    // (legacy tables are keyed only by cwd_hash). ALTER is idempotent-guarded.
    const cols = _db.prepare('PRAGMA table_info(checkpoints)').all();
    if (!cols.some(c => c.name === 'task_id')) {
      _db.exec('ALTER TABLE checkpoints ADD COLUMN task_id TEXT');
    }
    _db.exec('CREATE INDEX IF NOT EXISTS idx_cp_status ON checkpoints(status)');
    _db.exec('CREATE INDEX IF NOT EXISTS idx_cp_task ON checkpoints(task_id)');
    _stmts = {
      upsert: _db.prepare(`
        INSERT INTO checkpoints (cwd_hash, cwd, data, schema_ver, updated_at, status, task_id)
        VALUES (@cwdHash, @cwd, @data, @schemaVer, @updatedAt, @status, @taskId)
        ON CONFLICT(cwd_hash) DO UPDATE SET
          data=excluded.data, schema_ver=excluded.schema_ver,
          updated_at=excluded.updated_at, status=excluded.status, task_id=excluded.task_id
      `),
      load: _db.prepare('SELECT data, updated_at FROM checkpoints WHERE cwd_hash = @cwdHash'),
      loadByTask: _db.prepare('SELECT data, updated_at, cwd FROM checkpoints WHERE task_id = @taskId ORDER BY updated_at DESC LIMIT 1'),
      listResumable: _db.prepare("SELECT data, updated_at, cwd FROM checkpoints WHERE status IN ('in_progress','interrupted') ORDER BY updated_at DESC"),
      remove: _db.prepare('DELETE FROM checkpoints WHERE cwd_hash = @cwdHash'),
      hasPending: _db.prepare("SELECT 1 FROM checkpoints WHERE cwd_hash = @cwdHash AND status = 'in_progress'"),
      purgeExpired: _db.prepare('DELETE FROM checkpoints WHERE updated_at < @cutoff'),
    };
    _sqliteAvailable = true;
  } catch {
    _sqliteAvailable = false;
  }
  return _sqliteAvailable;
}

function _cwdHash(cwd) {
  return crypto.createHash('md5').update(String(cwd || '')).digest('hex');
}

function _boulderDir() {
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('boulder');
}

function _boulderPath(cwd) {
  return path.join(_boulderDir(), `${_cwdHash(cwd)}.json`);
}

/**
 * Truncate a conversation message for checkpoint storage.
 * Preserves role and essential content, trims large bodies.
 * @private
 */
function _truncateMessage(msg) {
  if (!msg) return null;
  const truncated = { role: msg.role || 'unknown' };
  if (typeof msg.content === 'string') {
    truncated.content = msg.content.slice(0, MAX_MESSAGE_CONTENT_LEN);
  } else if (Array.isArray(msg.content)) {
    // Multi-block content (tool_use, text, etc.) — keep structure, trim text
    truncated.content = msg.content.slice(0, 5).map(block => {
      if (!block) return block;
      if (block.type === 'text' && typeof block.text === 'string') {
        return { type: 'text', text: block.text.slice(0, MAX_MESSAGE_CONTENT_LEN) };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', name: block.name, id: block.id };
      }
      if (block.type === 'tool_result') {
        return { type: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error };
      }
      return { type: block.type };
    });
  }
  if (msg.uuid) truncated.uuid = msg.uuid;
  return truncated;
}

// ── Filesystem Snapshot ────────────────────────────────────────────────

/**
 * Capture a filesystem snapshot from the tool loop's fileReadHashes Map
 * and current git state.
 *
 * @param {string} cwd - Working directory
 * @param {Map<string,{hash:string,mtime:number,size:number}>} [fileReadHashes]
 * @returns {object} Snapshot { files, gitHead, gitDirty, snapshotAt }
 */
function captureFilesystemSnapshot(cwd, fileReadHashes) {
  const snapshot = {
    files: {},       // path → { hash, mtime, size }
    gitHead: null,   // commit SHA
    gitDirty: [],    // [{ path, status }]
    snapshotAt: Date.now(),
  };

  // 1. Files from fileReadHashes (agent-touched files with hashes)
  if (fileReadHashes instanceof Map) {
    let count = 0;
    for (const [absPath, info] of fileReadHashes) {
      if (count >= MAX_SNAPSHOT_FILES) break;
      snapshot.files[absPath] = {
        hash: info.hash || null,
        mtime: info.mtime || info.mtimeMs || null,
        size: info.size || null,
      };
      count++;
    }
  }

  // 2. Git state (best-effort, sync, bounded)
  try {
    const { execSync } = require('child_process');
    const execOpts = { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 };

    snapshot.gitHead = execSync('git rev-parse HEAD', execOpts).trim() || null;

    const porcelain = execSync('git status --porcelain -uno', execOpts).trim();
    if (porcelain) {
      snapshot.gitDirty = porcelain.split('\n').slice(0, 100).map(line => ({
        status: line.slice(0, 2).trim(),
        path: line.slice(3),
      }));
    }
  } catch { /* not a git repo or git unavailable */ }

  return snapshot;
}

/**
 * Compare a saved snapshot against the current filesystem state.
 * Returns a list of detected changes (drift).
 *
 * @param {string} cwd - Working directory
 * @param {object} savedSnapshot - Snapshot from a boulder checkpoint
 * @returns {{ changed: string[], deleted: string[], newCommits: boolean, summary: string }}
 */
function diffFilesystemSnapshot(cwd, savedSnapshot) {
  if (!savedSnapshot || !savedSnapshot.files) {
    return { changed: [], deleted: [], newCommits: false, summary: '' };
  }

  const changed = [];
  const deleted = [];

  // Compare file mtimes and sizes
  for (const [absPath, saved] of Object.entries(savedSnapshot.files)) {
    try {
      const stat = fs.statSync(absPath);
      if (saved.mtime && Math.abs(stat.mtimeMs - saved.mtime) > 1000) {
        changed.push(absPath);
      } else if (saved.size !== null && stat.size !== saved.size) {
        changed.push(absPath);
      }
    } catch {
      deleted.push(absPath);
    }
  }

  // Check for new commits since snapshot
  let newCommits = false;
  if (savedSnapshot.gitHead) {
    try {
      const { execSync } = require('child_process');
      const currentHead = execSync('git rev-parse HEAD', {
        cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
      }).trim();
      newCommits = currentHead !== savedSnapshot.gitHead;
    } catch { /* ignore */ }
  }

  const parts = [];
  if (changed.length > 0) parts.push(`${changed.length} file(s) modified externally`);
  if (deleted.length > 0) parts.push(`${deleted.length} file(s) deleted`);
  if (newCommits) parts.push('new commits since checkpoint');
  const summary = parts.length > 0
    ? `⚠ Workspace drift detected: ${parts.join(', ')}.`
    : '';

  return { changed, deleted, newCommits, summary };
}

/**
 * Save boulder checkpoint state to disk.
 * @param {string} cwd - Working directory (used as isolation key)
 * @param {object} state - Checkpoint data
 * @param {string}  state.taskId - Unique identifier for the task
 * @param {string}  state.userMessage - Original user message (truncated to 2000 chars)
 * @param {Array}   [state.toolCallLog] - Last N tool call entries
 * @param {number}  [state.iterations] - Total iterations completed
 * @param {number}  [state.continuationRound] - Current Ralph Loop round
 * @param {string[]} [state.activatedModes] - IntentGate activated modes
 * @param {string}  [state.status] - 'in_progress' | 'completed' | 'failed'
 * @param {Array}   [state.conversationMessages] - Recent conversation messages for full context restore
 * @param {string}  [state.contextSummary] - Compressed context summary from compactPipeline
 * @param {object}  [state.sessionMeta] - Session metadata (model, adapter, sessionId)
 */
function saveBoulderState(cwd, state) {
  if (!cwd || !state) return;
  const filePath = _boulderPath(cwd);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    taskId: state.taskId || _cwdHash(cwd + Date.now()),
    userMessage: String(state.userMessage || '').slice(0, MAX_USER_MESSAGE_LEN),
    toolCallLog: Array.isArray(state.toolCallLog)
      ? state.toolCallLog.slice(-MAX_TOOL_CALL_LOG_ENTRIES)
      : [],
    iterations: Number(state.iterations) || 0,
    continuationRound: Number(state.continuationRound) || 0,
    activatedModes: Array.isArray(state.activatedModes) ? state.activatedModes : [],
    status: state.status || 'in_progress',
    lastCheckpointAt: Date.now(),
    // ── Full context fields (v2) ──
    conversationMessages: Array.isArray(state.conversationMessages)
      ? state.conversationMessages.slice(-MAX_CONVERSATION_MESSAGES).map(_truncateMessage).filter(Boolean)
      : [],
    contextSummary: typeof state.contextSummary === 'string'
      ? state.contextSummary.slice(0, MAX_CONTEXT_SUMMARY_LEN)
      : '',
    sessionMeta: state.sessionMeta && typeof state.sessionMeta === 'object'
      ? {
          model: String(state.sessionMeta.model || '').slice(0, 100),
          adapter: String(state.sessionMeta.adapter || '').slice(0, 100),
          sessionId: String(state.sessionMeta.sessionId || '').slice(0, 64),
        }
      : null,
    // ── Phase 2 fields (v3) ──
    workflowStatus: state.workflowStatus || null,
    interruptReason: state.interruptReason || null,
    interruptedAtIteration: Number.isFinite(state.interruptedAtIteration) ? state.interruptedAtIteration : null,
    currentMessage: typeof state.currentMessage === 'string'
      ? state.currentMessage.slice(0, MAX_CURRENT_MESSAGE_LEN)
      : null,
    resumeData: state.resumeData && typeof state.resumeData === 'object'
      ? state.resumeData
      : null,
    // ── Phase 5 fields (v4): filesystem snapshot ──
    filesystemSnapshot: state.filesystemSnapshot || captureFilesystemSnapshot(cwd, state.fileReadHashes),
  };
  try {
    let json = JSON.stringify(record);
    // Hard cap: prevent runaway checkpoint data
    if (Buffer.byteLength(json) > MAX_BOULDER_FILE_BYTES) {
      record.conversationMessages = record.conversationMessages.slice(-10);
      record.contextSummary = record.contextSummary.slice(0, 2000);
      json = JSON.stringify(record);
    }

    // Primary: SQLite WAL (atomic, concurrent-safe)
    if (_initSqlite()) {
      try {
        _stmts.upsert.run({
          cwdHash: _cwdHash(cwd),
          cwd: String(cwd),
          data: json,
          schemaVer: SCHEMA_VERSION,
          updatedAt: Date.now(),
          status: record.status || 'in_progress',
          taskId: record.taskId || null,
        });
        return; // success — skip JSON fallback
      } catch { /* fall through to JSON */ }
    }

    // Fallback: JSON file (legacy path)
    fs.writeFileSync(filePath, json, 'utf-8');
  } catch { /* best-effort — never throw */ }
}

/**
 * Load boulder checkpoint state from disk.
 * Returns null if no checkpoint exists or it has expired (24h TTL).
 * Handles both v1 (toolCallLog only) and v2 (full context) schemas.
 * @param {string} cwd
 * @returns {object|null}
 */
function loadBoulderState(cwd) {
  if (!cwd) return null;

  // Primary: SQLite WAL
  if (_initSqlite()) {
    try {
      const row = _stmts.load.get({ cwdHash: _cwdHash(cwd) });
      if (row) {
        if (Date.now() - row.updated_at > TTL_MS) {
          _stmts.remove.run({ cwdHash: _cwdHash(cwd) });
          return null;
        }
        const record = JSON.parse(row.data);
        return _normalizeRecord(record);
      }
    } catch { /* fall through to JSON */ }
  }

  // Fallback: JSON file (legacy migration path)
  const filePath = _boulderPath(cwd);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const record = JSON.parse(raw);
    if (!record) return null;
    const validVersions = [1, 2, 3, 4];
    if (!validVersions.includes(record.schemaVersion)) return null;
    if (Date.now() - (record.lastCheckpointAt || 0) > TTL_MS) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    const normalized = _normalizeRecord(record);
    // Migrate JSON → SQLite on read (one-time)
    if (_sqliteAvailable && normalized) {
      try {
        _stmts.upsert.run({
          cwdHash: _cwdHash(cwd), cwd: String(cwd),
          data: JSON.stringify(normalized), schemaVer: SCHEMA_VERSION,
          updatedAt: normalized.lastCheckpointAt || Date.now(),
          status: normalized.status || 'in_progress',
          taskId: normalized.taskId || null,
        });
        fs.unlinkSync(filePath); // Remove old JSON after successful migration
      } catch { /* migration is best-effort */ }
    }
    return normalized;
  } catch {
    return null;
  }
}

/** Normalize v1/v2/v3 records to v4 shape */
function _normalizeRecord(record) {
  if (!record) return null;
  if (record.schemaVersion <= 1) {
    record.conversationMessages = record.conversationMessages || [];
    record.contextSummary = record.contextSummary || '';
    record.sessionMeta = record.sessionMeta || null;
  }
  if (record.schemaVersion <= 2) {
    record.workflowStatus = record.workflowStatus || null;
    record.interruptReason = record.interruptReason || null;
    record.interruptedAtIteration = record.interruptedAtIteration ?? null;
    record.currentMessage = record.currentMessage || null;
    record.resumeData = record.resumeData || null;
  }
  // v4: filesystem snapshot
  if (record.schemaVersion <= 3) {
    record.filesystemSnapshot = record.filesystemSnapshot || null;
  }
  return record;
}

/**
 * Load a checkpoint by its task id (regardless of cwd).
 * Returns the normalized record augmented with `cwd`, or null if missing/expired.
 * @param {string} taskId
 * @returns {object|null}
 */
function loadBoulderStateByTaskId(taskId) {
  if (!taskId || !_initSqlite()) return null;
  try {
    const row = _stmts.loadByTask.get({ taskId: String(taskId) });
    if (!row) return null;
    if (Date.now() - row.updated_at > TTL_MS) return null;
    const record = _normalizeRecord(JSON.parse(row.data));
    if (record) record.cwd = row.cwd;
    return record;
  } catch {
    return null;
  }
}

/**
 * List resumable checkpoints (status 'in_progress' or 'interrupted', not expired).
 * Returns lightweight summaries sorted newest-first.
 * @returns {Array<{taskId,cwd,status,userMessage,iterations,updatedAt}>}
 */
function listResumableTasks() {
  if (!_initSqlite()) return [];
  const cutoff = Date.now() - TTL_MS;
  const out = [];
  try {
    for (const row of _stmts.listResumable.all()) {
      if (row.updated_at < cutoff) continue;
      let rec;
      try { rec = JSON.parse(row.data); } catch { continue; }
      out.push({
        taskId: rec.taskId || null,
        cwd: rec.cwd || row.cwd || null,
        status: rec.status || 'in_progress',
        userMessage: String(rec.userMessage || '').slice(0, 120),
        iterations: Number(rec.iterations) || 0,
        updatedAt: row.updated_at,
      });
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * Flip the current cwd checkpoint to 'interrupted' so it survives auto-resume
 * matching (which only fires on 'in_progress') and stays addressable by task id.
 * No-op when there is no pending checkpoint. Returns the task id, or null.
 * @param {string} cwd
 * @param {object} [opts]
 * @param {string} [opts.interruptReason]
 * @returns {string|null} taskId of the interrupted checkpoint
 */
function markBoulderInterrupted(cwd, opts = {}) {
  if (!cwd) return null;
  const state = loadBoulderState(cwd);
  if (!state) return null;
  if (state.status !== 'in_progress' && state.status !== 'interrupted') return null;
  state.status = 'interrupted';
  if (opts.interruptReason) state.interruptReason = String(opts.interruptReason).slice(0, 500);
  // Preserve the existing snapshot — saveBoulderState would otherwise recompute it.
  saveBoulderState(cwd, state);
  return state.taskId || null;
}

/**
 * Re-arm a checkpoint for resume: look it up by task id and flip its status
 * back to 'in_progress' so the live auto-resume gate (which only matches
 * 'in_progress') will continue it on the next agent turn in its cwd.
 * @param {string} taskId
 * @returns {{taskId,cwd,userMessage,iterations,status}|null}
 */
function rearmForResume(taskId) {
  const record = loadBoulderStateByTaskId(taskId);
  if (!record || !record.cwd) return null;
  if (record.status === 'completed') return null;
  record.status = 'in_progress';
  saveBoulderState(record.cwd, record);
  return {
    taskId: record.taskId || taskId,
    cwd: record.cwd,
    userMessage: record.userMessage || '',
    iterations: Number(record.iterations) || 0,
    status: 'in_progress',
  };
}

/**
 * Clear boulder checkpoint for a given cwd.
 * @param {string} cwd
 */
function clearBoulderState(cwd) {
  if (!cwd) return;
  // SQLite
  if (_initSqlite()) {
    try { _stmts.remove.run({ cwdHash: _cwdHash(cwd) }); } catch { /* ignore */ }
  }
  // Also clean up any legacy JSON file
  try {
    const filePath = _boulderPath(cwd);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* ignore */ }
}

/**
 * Check whether a pending boulder checkpoint exists for the given cwd.
 * @param {string} cwd
 * @returns {boolean}
 */
function hasPendingBoulder(cwd) {
  if (!cwd) return false;
  // Fast path: SQLite query without parsing full JSON
  if (_initSqlite()) {
    try {
      const row = _stmts.hasPending.get({ cwdHash: _cwdHash(cwd) });
      if (row) return true;
    } catch { /* fall through */ }
  }
  // Fallback
  const state = loadBoulderState(cwd);
  return !!(state && state.status === 'in_progress');
}

/**
 * Purge all expired checkpoints from SQLite.
 * Call periodically (e.g., on startup or via cron) to prevent unbounded growth.
 * @returns {number} Number of rows deleted
 */
function purgeExpired() {
  if (!_initSqlite()) return 0;
  try {
    const result = _stmts.purgeExpired.run({ cutoff: Date.now() - TTL_MS });
    return result.changes || 0;
  } catch { return 0; }
}

/**
 * Simple message similarity check — compares first N characters.
 * Used to avoid resuming a checkpoint from a completely unrelated task.
 * @param {string} current
 * @param {string} saved
 * @returns {boolean}
 */
function isSimilarMessage(current, saved) {
  if (!current || !saved) return false;
  const a = String(current).trim().slice(0, 200).toLowerCase();
  const b = String(saved).trim().slice(0, 200).toLowerCase();
  if (a === b) return true;
  // Jaccard-like word overlap (>50% overlap = similar)
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  const unionSize = new Set([...wordsA, ...wordsB]).size;
  return (overlap / unionSize) > 0.5;
}

// For tests: reset module-level state
function _resetForTest() {
  if (_db) { try { _db.close(); } catch { /* ok */ } }
  _db = null;
  _stmts = {};
  _sqliteAvailable = false;
}

module.exports = {
  saveBoulderState,
  loadBoulderState,
  loadBoulderStateByTaskId,
  listResumableTasks,
  markBoulderInterrupted,
  rearmForResume,
  clearBoulderState,
  hasPendingBoulder,
  isSimilarMessage,
  purgeExpired,
  captureFilesystemSnapshot,
  diffFilesystemSnapshot,
  _resetForTest,
  // Expose for testing
  _boulderPath,
  _cwdHash,
  SCHEMA_VERSION,
  TTL_MS,
};
