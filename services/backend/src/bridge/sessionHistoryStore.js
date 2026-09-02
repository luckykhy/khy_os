'use strict';

/**
 * sessionHistoryStore — per-user chat-history persistence for the bridge
 * AI-chat consumer (PR: merge-khychat-into-bridge).
 *
 * One JSON file per userId, atomic tmp+rename writes (via
 * utils/atomicWriteJson — the project's single SoT for safe JSON writes).
 *
 *   ~/.khy/chat_history/<safeUserId>.json
 *
 * Why JSON files and not SQLite:
 *   - Aligned with project pattern for "small per-user persistence" (see
 *     user taste: "per-user JSON-file storage for small persistence needs
 *     over pulling in a database").
 *   - Fail-soft: any write/read error returns gracefully, never crashes
 *     the bridge consumer's turn loop.
 *   - Future migration to a real store is a separate concern; we keep the
 *     shape `{ version, userId, turns: [...] }` so a v2 schema swap is
 *     easy.
 *
 * Schema (v1):
 *   {
 *     version: 1,
 *     userId: string,
 *     turns: Array<{
 *       id: string,                  // turnId (uuid-ish, server-generated)
 *       startedAt: number,           // epoch ms
 *       finishedAt: number | null,   // epoch ms; null while in flight
 *       user: string,                 // user message text
 *       assistant: string,            // final assistant text (post-stream)
 *       cancelled: boolean,          // true if user issued type:'cancel'
 *     }>
 *   }
 */

const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');
const atomicWriteJson = require('../utils/atomicWriteJson');

const SCHEMA_VERSION = 1;
const MAX_TURNS_PER_USER = 200; // bound disk usage; older turns are dropped FIFO
const FILE_BASENAME_DIR = 'chat_history';

// `safeUserId`: keep filesystem-safe characters only. We don't try to be
// bulletproof (the caller controls userId), but at least strip path-traversal.
function _safeUserId(userId) {
  const raw = String(userId ?? '');
  if (!raw) {
    return 'anon';
  }
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'anon';
}

function _candidatePaths(userId) {
  const safe = _safeUserId(userId);
  return [
    path.join(getDataHome(), FILE_BASENAME_DIR, `${safe}.json`),
    path.join(getLegacyDataHome(), FILE_BASENAME_DIR, `${safe}.json`),
  ];
}

function _loadFromDisk(userId) {
  const paths = _candidatePaths(userId);
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) {
        continue;
      }
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === SCHEMA_VERSION && Array.isArray(parsed.turns)) {
        return { file: p, doc: parsed };
      }
      // Schema mismatch — fall through to create a fresh one.
    } catch {
      // Corrupt file: ignore and treat as missing (next write will overwrite).
    }
  }
  return { file: paths[0], doc: { version: SCHEMA_VERSION, userId, turns: [] } };
}

function _saveToDisk(filePath, doc) {
  // Pretty-printed for human inspection; trailingNewline=true so editors
  // don't complain; mode 0o600 mirrors atomicWriteJson default (user-only
  // on POSIX; Windows ignores it).
  return atomicWriteJson(filePath, doc, {
    pretty: 2,
    trailingNewline: true,
    mode: 0o600,
    ensureDir: true,
  });
}

/**
 * Load the full document for a user. Returns the in-memory shape
 * (always includes version+turns, even when the file does not yet exist).
 * Never throws.
 */
function loadHistory(userId) {
  const { doc } = _loadFromDisk(userId);
  return doc;
}

/**
 * Append one turn, persist, and return the saved doc.
 * The caller is expected to update the turn (assistant text, finishedAt)
 * and call updateTurn() later; this is just the "kickoff" append.
 * Never throws.
 */
function appendTurn(userId, turn) {
  if (!turn || !turn.id) {
    return loadHistory(userId);
  }
  const { file, doc } = _loadFromDisk(userId);
  doc.turns.push({
    id: String(turn.id),
    startedAt: Number(turn.startedAt) || Date.now(),
    finishedAt: null,
    user: String(turn.user || ''),
    assistant: '',
    cancelled: false,
  });
  if (doc.turns.length > MAX_TURNS_PER_USER) {
    doc.turns.splice(0, doc.turns.length - MAX_TURNS_PER_USER);
  }
  doc.userId = userId;
  const ok = _saveToDisk(file, doc);
  if (!ok) {
    // best-effort: still return the in-memory doc so the turn can proceed
    return doc;
  }
  return doc;
}

/**
 * Patch an existing turn (by id) with a partial update. Returns true on
 * successful persist, false on any error (file write / id-not-found / etc.).
 * Never throws.
 */
function updateTurn(userId, turnId, patch) {
  if (!turnId) {
    return false;
  }
  const { file, doc } = _loadFromDisk(userId);
  const idx = doc.turns.findIndex((t) => t && t.id === turnId);
  if (idx < 0) {
    return false;
  }
  doc.turns[idx] = { ...doc.turns[idx], ...(patch || {}) };
  return _saveToDisk(file, doc);
}

/**
 * Test-only: force-clear the stored history for a user.
 * Production code never calls this; exported for unit tests.
 */
function _resetForTest(userId) {
  const paths = _candidatePaths(userId);
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch {
      /* ignore */
    }
  }
}

module.exports = {
  loadHistory,
  appendTurn,
  updateTurn,
  _safeUserId,
  _resetForTest,
  SCHEMA_VERSION,
  MAX_TURNS_PER_USER,
};
