'use strict';

/**
 * Session Search Index — SQLite FTS5 search index for conversation history.
 *
 * Write-through companion to sessionPersistence.js (JSON files remain primary).
 * Provides full-text search across all indexed sessions using FTS5 + BM25 ranking.
 *
 * Database: ~/.khyquant/sessions.db (WAL mode)
 *
 * @module sessionSearchIndex
 */

const fs = require('fs');
const path = require('path');

let _db = null;
let _stmts = {};
let _available = false;

// ── Database path ──

function _dbPath() {
  try {
    const { getProjectDataDir } = require('../utils/dataHome');
    return path.join(getProjectDataDir(), 'sessions.db');
  } catch {
    const os = require('os');
    const dir = path.join(os.homedir(), '.khyquant');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    return path.join(dir, 'sessions.db');
  }
}

// ── Public API ──

/**
 * Initialize the SQLite database and tables.
 * Creates sessions.db with WAL mode, conversations + messages + FTS5 tables.
 * Safe to call multiple times (idempotent).
 */
function init() {
  if (_db) return;

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    // better-sqlite3 not available — search is silently disabled
    _available = false;
    return;
  }

  try {
    _db = new Database(_dbPath());
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        message_count INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        uuid TEXT,
        parent_uuid TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER,
        FOREIGN KEY (session_id) REFERENCES conversations(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_uuid ON messages(uuid);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
    `);

    // Prepare statements
    _stmts.upsertConv = _db.prepare(`
      INSERT INTO conversations (session_id, title, model, message_count, created_at, updated_at)
      VALUES (@sessionId, @title, @model, @messageCount, @createdAt, @updatedAt)
      ON CONFLICT(session_id) DO UPDATE SET
        title = @title, model = @model, message_count = @messageCount, updated_at = @updatedAt
    `);

    _stmts.insertMsg = _db.prepare(`
      INSERT INTO messages (session_id, uuid, parent_uuid, role, content, timestamp)
      VALUES (@sessionId, @uuid, @parentUuid, @role, @content, @timestamp)
    `);

    _stmts.deleteConvMsgs = _db.prepare('DELETE FROM messages WHERE session_id = ?');
    _stmts.deleteConv = _db.prepare('DELETE FROM conversations WHERE session_id = ?');

    _stmts.search = _db.prepare(`
      SELECT m.session_id, c.title, m.role, m.content, m.timestamp, m.uuid, m.parent_uuid,
             rank AS bm25_rank
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      LEFT JOIN conversations c ON c.session_id = m.session_id
      WHERE messages_fts MATCH @query
      ORDER BY rank
      LIMIT @limit OFFSET @offset
    `);

    _stmts.searchSince = _db.prepare(`
      SELECT m.session_id, c.title, m.role, m.content, m.timestamp, m.uuid, m.parent_uuid,
             rank AS bm25_rank
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      LEFT JOIN conversations c ON c.session_id = m.session_id
      WHERE messages_fts MATCH @query AND m.timestamp >= @since
      ORDER BY rank
      LIMIT @limit OFFSET @offset
    `);

    _stmts.searchBySession = _db.prepare(`
      SELECT m.session_id, c.title, m.role, m.content, m.timestamp, m.uuid, m.parent_uuid,
             rank AS bm25_rank
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      LEFT JOIN conversations c ON c.session_id = m.session_id
      WHERE messages_fts MATCH @query AND m.session_id = @sessionId
      ORDER BY rank
      LIMIT @limit OFFSET @offset
    `);

    _stmts.countConvs = _db.prepare('SELECT COUNT(*) AS count FROM conversations');
    _stmts.countMsgs = _db.prepare('SELECT COUNT(*) AS count FROM messages');
    _stmts.existingMsgCount = _db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?');

    _available = true;
  } catch (err) {
    _db = null;
    _available = false;
  }
}

/**
 * Index a session's messages into SQLite.
 * Upserts the conversation row and inserts new messages.
 * @param {string} sessionId
 * @param {object} sessionData - { title, model, messages[], createdAt, updatedAt }
 */
function indexSession(sessionId, sessionData) {
  if (!_available || !_db) return;

  const messages = sessionData.messages || [];

  try {
    const txn = _db.transaction(() => {
      // Upsert conversation
      _stmts.upsertConv.run({
        sessionId,
        title: sessionData.title || '',
        model: sessionData.model || '',
        messageCount: messages.length,
        createdAt: sessionData.createdAt || Date.now(),
        updatedAt: sessionData.updatedAt || Date.now(),
      });

      // Check how many messages already indexed for this session
      const existing = _stmts.existingMsgCount.get(sessionId);
      const existingCount = existing ? existing.count : 0;

      // Only insert new messages (append-only)
      for (let i = existingCount; i < messages.length; i++) {
        const msg = messages[i];
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
        if (!content.trim()) continue;
        _stmts.insertMsg.run({
          sessionId,
          uuid: msg.uuid || null,
          parentUuid: msg.parentUuid || null,
          role: msg.role || 'unknown',
          content,
          timestamp: msg.timestamp || Date.now(),
        });
      }
    });

    txn();
  } catch { /* indexing failure is non-fatal */ }
}

/**
 * Full-text search across all indexed messages.
 * Uses FTS5 MATCH with BM25 ranking.
 * @param {string} query - User search query
 * @param {object} [opts] - { limit: 20, offset: 0, since: timestamp, sessionId: string }
 * @returns {Array<{ sessionId, title, role, content, timestamp, uuid, parentUuid, rank }>}
 */
function searchMessages(query, opts = {}) {
  if (!_available || !_db || !query) return [];

  const limit = opts.limit || 20;
  const offset = opts.offset || 0;

  try {
    // Sanitize query for FTS5 trigram — strip quotes and use raw text
    const safeQuery = query.replace(/['"]/g, '').trim();
    if (!safeQuery) return [];

    let rows;
    if (opts.sessionId) {
      rows = _stmts.searchBySession.all({ query: safeQuery, sessionId: opts.sessionId, limit, offset });
    } else if (opts.since) {
      rows = _stmts.searchSince.all({ query: safeQuery, since: opts.since, limit, offset });
    } else {
      rows = _stmts.search.all({ query: safeQuery, limit, offset });
    }
    return rows.map(r => ({
      sessionId: r.session_id,
      title: r.title || '',
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      uuid: r.uuid || null,
      parentUuid: r.parent_uuid || null,
      rank: r.bm25_rank,
    }));
  } catch {
    return [];
  }
}

/**
 * Delete a session's index entries.
 * @param {string} sessionId
 */
function removeSessionIndex(sessionId) {
  if (!_available || !_db) return;
  try {
    const txn = _db.transaction(() => {
      _stmts.deleteConvMsgs.run(sessionId);
      _stmts.deleteConv.run(sessionId);
    });
    txn();
  } catch { /* non-fatal */ }
}

/**
 * Get index statistics.
 * @returns {{ totalSessions: number, totalMessages: number, dbSizeBytes: number }}
 */
function getStats() {
  if (!_available || !_db) {
    return { totalSessions: 0, totalMessages: 0, dbSizeBytes: 0, available: false };
  }

  try {
    const sessions = _stmts.countConvs.get().count;
    const messages = _stmts.countMsgs.get().count;
    let dbSize = 0;
    try { dbSize = fs.statSync(_dbPath()).size; } catch { /* ok */ }
    return { totalSessions: sessions, totalMessages: messages, dbSizeBytes: dbSize, available: true };
  } catch {
    return { totalSessions: 0, totalMessages: 0, dbSizeBytes: 0, available: false };
  }
}

/**
 * Check if the search index is available.
 * @returns {boolean}
 */
function isAvailable() {
  return _available;
}

/**
 * Run WAL checkpoint to prevent unbounded WAL file growth.
 * Should be called periodically (e.g., every 10 minutes or on shutdown).
 * @param {'PASSIVE'|'FULL'|'RESTART'|'TRUNCATE'} [mode='PASSIVE']
 * @returns {{ walPages: number, movedPages: number } | null}
 */
function walCheckpoint(mode = 'PASSIVE') {
  if (!_db) return null;
  try {
    const result = _db.pragma(`wal_checkpoint(${mode})`);
    return result && result[0]
      ? { walPages: result[0].wal || 0, movedPages: result[0].checkpointed || 0 }
      : null;
  } catch { return null; }
}

/**
 * Rebuild the FTS5 index to reclaim tombstone space.
 * Call after bulk deletes or on maintenance schedule.
 */
function ftsOptimize() {
  if (!_db) return;
  try {
    _db.exec("INSERT INTO messages_fts(messages_fts) VALUES('optimize')");
  } catch { /* non-critical */ }
}

/**
 * Backfill reindex — scan all persisted sessions and reindex into FTS5.
 * Idempotent: uses the existing append-only logic (skips already-indexed messages).
 * Call on first run or after database reset to populate the search index.
 *
 * @param {object} [opts]
 * @param {number} [opts.batchSize=50] - Number of sessions to process per transaction
 * @param {Function} [opts.onProgress] - Progress callback: ({ indexed, skipped, total }) => void
 * @returns {{ indexed: number, skipped: number, total: number, elapsed: number }}
 */
function reindexAll(opts = {}) {
  if (!_available || !_db) {
    init();
    if (!_available) return { indexed: 0, skipped: 0, total: 0, elapsed: 0 };
  }

  const start = Date.now();
  const batchSize = opts.batchSize || 50;
  const onProgress = opts.onProgress || null;
  let indexed = 0, skipped = 0, total = 0;

  try {
    // Resolve the bulk session source via the neutral port instead of requiring
    // sessionPersistence back (breaks the R3 cycle; DESIGN-ARCH-020). Callers
    // may also inject opts.source explicitly. If persistence was never loaded,
    // there is nothing to reindex — degrade to an empty result.
    const sessionPersistence = opts.source || require('./sessionSourcePort').getSessionSource();
    if (!sessionPersistence) {
      return { indexed: 0, skipped: 0, total: 0, elapsed: Date.now() - start };
    }
    const sessions = sessionPersistence.listPersistedSessions({ limit: 10000 });
    total = sessions.length;

    for (let i = 0; i < sessions.length; i += batchSize) {
      const batch = sessions.slice(i, i + batchSize);
      for (const sess of batch) {
        try {
          const data = sessionPersistence.restoreSession(sess.sessionId);
          if (data && data.messages && data.messages.length > 0) {
            indexSession(sess.sessionId, data);
            indexed++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
      if (onProgress) {
        try { onProgress({ indexed, skipped, total }); } catch { /* non-critical */ }
      }
    }

    // Optimize FTS after bulk insert
    ftsOptimize();
    walCheckpoint('PASSIVE');
  } catch { /* reindex is best-effort */ }

  return { indexed, skipped, total, elapsed: Date.now() - start };
}

/** @internal Close DB and reset for testing */
function _resetForTest() {
  if (_db) {
    try { _db.close(); } catch { /* ok */ }
  }
  _db = null;
  _stmts = {};
  _available = false;
}

module.exports = {
  init,
  indexSession,
  searchMessages,
  removeSessionIndex,
  getStats,
  isAvailable,
  walCheckpoint,
  ftsOptimize,
  reindexAll,
  _resetForTest,
  _dbPath,
};
