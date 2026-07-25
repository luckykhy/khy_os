'use strict';

/**
 * remoteDevSessionStore.js — thin IO shell for the durable "current remote dev
 * session" pointer.
 *
 * Why this exists: SSH sessions in this codebase are logical metadata held in an
 * in-memory Map (sshConnectionManager) that does NOT survive a process restart,
 * and remoteStatePersistence only persists {approvals, streams} — never the
 * session identity. So nothing on disk records "which remote dev session am I
 * in". This store is that single durable pointer, making the active session
 * discoverable across separate `khy` invocations.
 *
 * All operations are best-effort and NEVER throw — a missing/corrupt pointer is
 * simply treated as "no current session".
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');

/** Absolute path to the pointer file: <dataHome>/remotedev/session.json */
function pointerPath() {
  return path.join(getDataDir('remotedev'), 'session.json');
}

/** Read the persisted descriptor, or null if absent/unreadable. */
function readPointer() {
  try {
    const raw = fs.readFileSync(pointerPath(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** Atomically write the descriptor (temp + rename). Returns the descriptor or null. */
function writePointer(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  try {
    const file = pointerPath();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(descriptor, null, 2));
    fs.renameSync(tmp, file);
    return descriptor;
  } catch {
    return null;
  }
}

/** Remove the pointer. Returns true if a file was removed, false otherwise. */
function clearPointer() {
  try {
    fs.unlinkSync(pointerPath());
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  pointerPath,
  readPointer,
  writePointer,
  clearPointer,
};
