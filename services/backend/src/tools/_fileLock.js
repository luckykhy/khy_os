'use strict';

/**
 * _fileLock.js — Cross-process, single-file advisory locking for the file tools.
 *
 * WHY: multiple khyos instances can run in the same working directory. The file
 * tools (Write / Edit / MultiEdit / NotebookEdit / FileOp …) all do naked
 * `fs.writeFileSync` with no coordination — and the edit-family tools are
 * read-modify-write, so two instances editing one file would race and the last
 * writer would silently clobber the other (data loss).
 *
 * This module provides a per-file lock that:
 *   - is EXCLUSIVE for writers (write-exclusive) and SHARED for readers
 *     (read-shared) — "读共享、写独占";
 *   - is FILE-GRAINED (one lock per absolute path), never directory-wide, so
 *     unrelated files never block each other;
 *   - is CROSS-PLATFORM with ZERO native deps — it relies only on the atomicity
 *     of `fs.mkdirSync` (guaranteed on Linux ext4 + tmpfs and on Windows NTFS)
 *     on `process.kill(pid, 0)` liveness probing (works on both OSes);
 *   - is ZOMBIE-IMMUNE — every holder stamps {pid, host, heartbeatAt} and runs a
 *     heartbeat; if a holder crashes or is killed, other instances detect the
 *     dead PID (same host) or the stale heartbeat (any host) and safely reclaim
 *     the lock via an atomic rename-steal, so a dead process never deadlocks the
 *     rest;
 *   - has a hard TIMEOUT (default 30 s) after which `acquire` THROWS a clear
 *     FileLockTimeoutError for the Agent to handle — it never hangs forever.
 *
 * 防呆 (fail-safe) boundaries honored by this module:
 *   - All lock LOGIC lives here, in the tool layer. The scheduler
 *     (toolUseLoop / toolExecutionEngine) is never touched.
 *   - Acquire has an upper-bound timeout and throws on expiry — no infinite hang.
 *   - The lock is advisory: if locking itself errors in an unexpected way, the
 *     caller may choose to proceed (the decorator does), so the lock subsystem
 *     can never make a write fail for reasons unrelated to genuine contention.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Tunables (all overridable by env for ops) ──────────────────────
// Lock root is resolved lazily (per call) so KHY_FILE_LOCK_DIR can be set/changed
// without a restart, and so tests can isolate their lock space.
function _lockRoot() {
  return process.env.KHY_FILE_LOCK_DIR || path.join(os.tmpdir(), 'khy-file-locks');
}
const DEFAULT_TIMEOUT_MS = _envInt('KHY_FILE_LOCK_TIMEOUT_MS', 30000);   // 防呆: hard ceiling
const HEARTBEAT_MS       = _envInt('KHY_FILE_LOCK_HEARTBEAT_MS', 5000);
const STALE_MS           = _envInt('KHY_FILE_LOCK_STALE_MS', 15000);     // 3× heartbeat
const POLL_MIN_MS        = 25;
const POLL_MAX_MS        = 250;

const HOST = os.hostname();

// In-process registry of locks this process currently holds, keyed by lock key.
// Guards against self-deadlock: if the same process re-acquires a path it already
// holds (re-entrancy), we refcount instead of mkdir-ing against our own lock.
const _heldLocks = new Map(); // key -> { count, token, lockDir, heartbeatTimer }

/** Tool names (normalized: lowercased, separators stripped) that mutate files. */
const WRITE_TOOL_NAMES = new Set([
  'writefile', 'write', 'filewrite', 'filewritetool', 'createfile',
  'editfile', 'edit', 'fileedit', 'fileedittool',
  'multiedit', 'multiedittool',
  'notebookedit', 'notebookedittool',
  'fileop', 'fileoperation',
]);

const PATH_KEYS = ['path', 'file_path', 'filePath', 'notebook_path', 'notebookPath'];

class FileLockTimeoutError extends Error {
  constructor(absPath, timeoutMs, holder) {
    const who = holder
      ? ` held by pid ${holder.pid}@${holder.host} since ${new Date(holder.acquiredAt || Date.now()).toISOString()}`
      : '';
    super(
      `File is locked by another khyos instance${who}; ` +
      `could not acquire write lock on "${absPath}" within ${timeoutMs}ms. ` +
      `Retry, write to a conflict copy, or ask the user which version to keep — do not overwrite.`
    );
    this.name = 'FileLockTimeoutError';
    this.code = 'EFILELOCKTIMEOUT';
    this.filePath = absPath;
    this.timeoutMs = timeoutMs;
    this.holder = holder || null;
  }
}

function _envInt(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const _normalizeToolName = require('../utils/normalizeToolName');

/** Resolve a tool call's target file path (absolute), or null if none. */
function resolveTargetPath(params) {
  if (!params || typeof params !== 'object') return null;
  for (const key of PATH_KEYS) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      return path.isAbsolute(v) ? v : path.resolve(cwd, v);
    }
  }
  return null;
}

function isWriteTool(toolName) {
  return WRITE_TOOL_NAMES.has(_normalizeToolName(toolName));
}

/** Stable lock key + on-disk lock directory for an absolute path. */
function _lockPaths(absPath) {
  // Normalize for case-insensitive filesystems so "A.txt" and "a.txt" collide on
  // Windows the same way the FS does. Hash to keep the key filesystem-safe and
  // bounded regardless of path length / unicode.
  const norm = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  const key = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
  return { key, lockDir: path.join(_lockRoot(), `${key}.lock`) };
}

function _readMeta(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'meta.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null; // missing / corrupt / mid-write — treat as unknown holder
  }
}

function _writeMeta(lockDir, meta) {
  try {
    fs.writeFileSync(path.join(lockDir, 'meta.json'), JSON.stringify(meta), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {boolean|null} true=alive, false=dead, null=unknown (different host)
 */
function _isPidAlive(pid, host) {
  if (!pid) return false;
  if (host && host !== HOST) return null; // can't probe a PID on another machine
  try {
    process.kill(pid, 0); // signal 0 = existence check, no signal delivered
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false; // no such process → dead
    if (err && err.code === 'EPERM') return true;   // exists, not ours → alive
    return true; // be conservative: unknown error → assume alive (don't steal)
  }
}

/** A lock is stale (reclaimable) when its holder is provably gone. */
function _isStale(meta) {
  if (!meta) return true; // corrupt/empty meta → reclaimable
  const alive = _isPidAlive(meta.pid, meta.host);
  if (alive === false) return true;  // process gone on this host
  if (alive === true) return false;  // holder alive — respect it
  // Different host: rely solely on heartbeat freshness.
  const hb = Number(meta.heartbeatAt) || 0;
  const age = Date.now() - hb;
  if (age < 0) return false;         // clock skew (future) → treat as fresh
  return age > STALE_MS;
}

/**
 * Try to reclaim a stale lock dir atomically. Uses rename-steal: whoever renames
 * the stale dir to a unique temp name "wins" the reclaim (rename is atomic), then
 * deletes it. Losers get ENOENT and simply re-loop to re-read the (now fresh)
 * holder. This guarantees we never delete a lock that was *just* re-acquired by a
 * live instance.
 * @returns {boolean} true if we successfully cleared the stale dir
 */
function _reclaimStale(lockDir) {
  const steal = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lockDir, steal);
  } catch {
    return false; // someone else stole/refreshed it first — re-loop
  }
  try {
    fs.rmSync(steal, { recursive: true, force: true });
  } catch { /* best-effort: orphan temp dir is harmless, gets GC'd by ops */ }
  return true;
}

function _startHeartbeat(lockDir, meta) {
  const timer = setInterval(() => {
    meta.heartbeatAt = Date.now();
    _writeMeta(lockDir, meta);
  }, HEARTBEAT_MS);
  if (timer.unref) timer.unref(); // never keep the process alive for a heartbeat
  return timer;
}

/**
 * Acquire a lock on an absolute path.
 *
 * @param {string} absPath
 * @param {{ mode?: 'exclusive'|'shared', timeoutMs?: number, toolName?: string }} [opts]
 * @returns {Promise<{release: () => void, filePath: string, key: string, reentrant: boolean}>}
 * @throws {FileLockTimeoutError} when the lock cannot be acquired before timeout.
 */
async function acquire(absPath, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const { key, lockDir } = _lockPaths(absPath);

  // Re-entrancy: this process already holds it → refcount, no real lock op.
  const existing = _heldLocks.get(key);
  if (existing) {
    existing.count += 1;
    return _makeHandle(key, absPath, true);
  }

  try { fs.mkdirSync(_lockRoot(), { recursive: true }); } catch { /* exists */ }

  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      fs.mkdirSync(lockDir); // atomic: succeeds for exactly one acquirer
      const meta = {
        pid: process.pid, host: HOST, token,
        mode: opts.mode || 'exclusive',
        toolName: opts.toolName || null,
        acquiredAt: Date.now(), heartbeatAt: Date.now(),
      };
      _writeMeta(lockDir, meta);
      const heartbeatTimer = _startHeartbeat(lockDir, meta);
      _heldLocks.set(key, { count: 1, token, lockDir, heartbeatTimer });
      return _makeHandle(key, absPath, false);
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        // Unexpected FS error (e.g. permission). 防呆: don't trap the write —
        // signal "no lock" so the decorator proceeds without locking.
        const e = new Error(`file lock unavailable: ${err && err.message}`);
        e.code = 'EFILELOCKUNAVAILABLE';
        throw e;
      }
      // Contended: inspect the current holder.
      const meta = _readMeta(lockDir);
      if (_isStale(meta)) {
        _reclaimStale(lockDir);
        continue; // retry immediately after reclaim attempt
      }
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(absPath, timeoutMs, meta);
      }
      // Randomized backoff to avoid thundering-herd retries between instances.
      const jitter = POLL_MIN_MS + Math.floor(Math.random() * (POLL_MAX_MS - POLL_MIN_MS));
      await _sleep(Math.min(jitter, Math.max(POLL_MIN_MS, deadline - Date.now())));
    }
  }
}

function _makeHandle(key, filePath, reentrant) {
  let released = false;
  return {
    filePath,
    key,
    reentrant,
    release() {
      if (released) return; // idempotent
      released = true;
      const held = _heldLocks.get(key);
      if (!held) return;
      held.count -= 1;
      if (held.count > 0) return; // still held by an outer re-entrant acquire
      _heldLocks.delete(key);
      try { clearInterval(held.heartbeatTimer); } catch { /* noop */ }
      // Only remove the dir if we still own it (token matches) — never delete a
      // lock that was reclaimed from us as a zombie and handed to someone else.
      try {
        const meta = _readMeta(held.lockDir);
        if (!meta || meta.token === held.token) {
          fs.rmSync(held.lockDir, { recursive: true, force: true });
        }
      } catch { /* best-effort */ }
    },
  };
}

/**
 * Decorator entry point for the tool layer: acquire an exclusive lock for a
 * file-mutating tool call, or return null if the call is not a write tool or has
 * no resolvable single path (e.g. apply_patch's multi-file patch text). A null
 * return means "run without locking" — the caller must tolerate it.
 *
 * @param {string} toolName
 * @param {object} params
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{release:()=>void}|null>}
 * @throws {FileLockTimeoutError} on contention timeout (surfaced to the Agent).
 */
async function acquireForToolCall(toolName, params, opts = {}) {
  if (process.env.KHY_FILE_LOCK_DISABLED === '1') return null;
  if (!isWriteTool(toolName)) return null;
  const absPath = resolveTargetPath(params);
  if (!absPath) return null; // unknown / multi-file target → no single-path lock
  return acquire(absPath, {
    mode: 'exclusive',
    timeoutMs: opts.timeoutMs,
    toolName,
  });
}

/**
 * Conflict-copy path helper for the documented "never silently overwrite"
 * recovery: turns /dir/app.py into /dir/app_conflict_khy<tag>.py. The Agent (or
 * a future auto-fallback) can redirect a contended write here instead of failing.
 * @param {string} absPath
 * @param {string|number} tag
 * @returns {string}
 */
function conflictCopyPath(absPath, tag) {
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  const safeTag = String(tag == null ? process.pid : tag).replace(/[^\w.-]/g, '');
  return path.join(dir, `${base}_conflict_khy${safeTag}${ext}`);
}

module.exports = {
  acquire,
  acquireForToolCall,
  resolveTargetPath,
  isWriteTool,
  conflictCopyPath,
  FileLockTimeoutError,
  // Exposed for tests / ops:
  WRITE_TOOL_NAMES,
  lockRoot: _lockRoot,
  _lockPaths,
  _isStale,
  _isPidAlive,
  _heldLocks,
};
