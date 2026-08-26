'use strict';

/**
 * dbHealthService.js — SQLite database corruption detection and self-healing.
 *
 * Implements automatic recovery for sessions.db, taskboard.db, and other SQLite databases:
 * - Startup integrity checks (quick_check < 100ms per database)
 * - Multi-stage recovery: WAL checkpoint → .recover → backup restore → rebuild
 * - Periodic WAL checkpoint (every 6h) to prevent unbounded growth
 * - Automatic backup on clean shutdown (keeps 3 most recent copies)
 * - Comprehensive audit logging for all healing operations
 *
 * @module services/dbHealthService
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { hotCopySqlite, restoreSqliteInPlace } = require('./backup/sqliteHotCopy');

// ── Constants ──

const WAL_CHECKPOINT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_BACKUPS_TO_KEEP = 3;
const QUICK_CHECK_TIMEOUT_MS = 100;

// ── Lock-aware recovery primitives ──

// Transient Windows file locks surface as these errno codes while a sibling
// khy process still holds the database open during heal-time file surgery.
const BUSY_ERRNO = new Set(['EBUSY', 'EPERM', 'EACCES']);
const BUSY_TEXT_PATTERN = /EBUSY|EPERM|EACCES|sharing violation|resource busy|being used by another process/i;

/**
 * Detect "file held by another process" style failures from either an Error
 * object (errno/code) or a plain human-readable message.
 */
function _isBusyError(err) {
  if (!err) return false;
  if (typeof err === 'string') return BUSY_TEXT_PATTERN.test(err);
  if (BUSY_ERRNO.has(err.code)) return true;
  return BUSY_TEXT_PATTERN.test(String(err.message || ''));
}

/**
 * Synchronous sleep for retry backoff inside otherwise-sync fs repair paths.
 */
function _sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — proceed without waiting */
  }
}

// Backoff ladder for heal-time file operations; total budget ≈ 3.9s per op.
const FS_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000];

/**
 * Run a filesystem operation, tolerating transient locks from sibling khy
 * processes. Retries only on busy-style errors with a growing delay; any other
 * error (and exhaustion of the ladder) propagates immediately.
 */
function _retryFsOperation(operation, label, meta = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= FS_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (!_isBusyError(err) || attempt === FS_RETRY_DELAYS_MS.length) break;
      _sleepSync(FS_RETRY_DELAYS_MS[attempt]);
      void label; // label reserved for future audit surfacing of retries
    }
  }
  lastErr.attempts = FS_RETRY_DELAYS_MS.length + 1;
  throw lastErr;
}

/**
 * Ask same-install khy processes (the background daemon) to release database
 * handles before heal-time rename/unlink work. Only ever touches the daemon
 * recorded in our own pid file — never arbitrary processes.
 *
 * `opts.pidFile` overrides the daemon pid file location (tests inject a
 * temp path; production always uses the real data home).
 */
function _releaseKhyDbLocks(dbPath, opts = {}) {
  try {
    let pidFile = opts.pidFile;
    if (!pidFile) {
      const { getDataDir } = require('../utils/dataHome');
      pidFile = path.join(getDataDir(), 'daemon.pid');
    }
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
    const holderPid = Number(info && info.pid);
    if (!Number.isFinite(holderPid) || holderPid <= 0 || holderPid === process.pid) {
      return { attempted: false, stopped: false };
    }

    _logHealAudit({
      level: 'warn',
      message: `数据库文件被本机 khy 守护进程(pid ${holderPid})锁定，停止守护进程以释放句柄`,
      meta: { dbPath, holderPid },
    });

    let stopped = false;
    try {
      const { daemonStop } = require('./daemonManager');
      daemonStop();
      stopped = true;
    } catch (err) {
      _logHealAudit({
        level: 'warn',
        message: `停止 khy 守护进程失败: ${err.message}`,
        meta: { dbPath, holderPid },
      });
    }

    // Give the OS a moment to actually release the file handles.
    _sleepSync(500);
    return { attempted: true, stopped };
  } catch {
    // No pid file / unreadable — nothing to release.
    return { attempted: false, stopped: false };
  }
}

// ── State ──

let _checkpointTimer = null;
let _healAuditLog = [];
let _knownDatabases = [];
let _consoleLoggingEnabled = true;

// ── Audit Logging ──

/**
 * Write a heal audit entry to memory and optionally to disk.
 */
function _logHealAudit(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  _healAuditLog.push(record);

  // Keep only last 100 entries in memory
  if (_healAuditLog.length > 100) {
    _healAuditLog.shift();
  }

  // Machine-readable CLI commands reserve stdout for their payload. Audit
  // persistence remains active even when immediate console visibility is off.
  if (_consoleLoggingEnabled) {
    const logger = _getLogger();
    if (entry.level === 'error') {
      logger.error(`[DB Health] ${entry.message}`, entry.meta || {});
    } else if (entry.level === 'warn') {
      logger.warn(`[DB Health] ${entry.message}`, entry.meta || {});
    } else {
      logger.info(`[DB Health] ${entry.message}`, entry.meta || {});
    }
  }

  // Persist to unified heal audit service
  try {
    const healAuditService = require('./healAuditService');
    // logHealEvent drops records with a falsy target, so always resolve a
    // non-empty one — otherwise successful heal messages (whose meta carries
    // only `method`) would never reach the audit trail.
    const meta = entry.meta || {};
    // `result` is what monitoring filters on, so it must reflect the outcome
    // rather than the console log level: a stage that failed is a failure even
    // when it is reported at info/warn level because the cascade continues.
    // Callers may state it explicitly; otherwise error/warn map to failure.
    const result = entry.result
      || (entry.level === 'error' || entry.level === 'warn' ? 'failure' : 'success');
    const auditEntry = {
      component: 'dbHealth',
      action: entry.message,
      target: meta.dbPath || meta.dbName || 'unknown',
      result,
      details: entry.meta ? JSON.stringify(entry.meta) : undefined,
    };
    healAuditService.logHealEvent(auditEntry);
  } catch {
    // Fail-soft: unified audit service unavailable
  }
}

function _getLogger() {
  try {
    return require('../utils/logger');
  } catch {
    return console;
  }
}

// ── Database Path Resolution ──

/**
 * Get the list of known critical databases.
 * Returns array of {name, path} objects.
 */
function _discoverDatabases() {
  const databases = [];

  try {
    const { getDataDir, getProjectDataDir } = require('../utils/dataHome');

    // Main databases
    databases.push({
      name: 'sessions.db',
      path: path.join(getProjectDataDir(), 'sessions.db'),
      critical: true,
    });

    databases.push({
      name: 'taskboard.db',
      path: path.join(getDataDir(), 'taskboard.db'),
      critical: true,
    });

    // khy-Trajectory database (if it exists)
    const trajectoryPath = path.join(process.cwd(), 'khy-Trajectory', 'sessions.db');
    if (fs.existsSync(trajectoryPath)) {
      databases.push({
        name: 'khy-Trajectory/sessions.db',
        path: trajectoryPath,
        critical: false,
      });
    }
  } catch (err) {
    _logHealAudit({
      level: 'warn',
      message: 'Failed to discover databases, using fallback paths',
      meta: { error: err.message },
    });

    // Fallback to .khy directory
    const khyDir = path.join(process.cwd(), '.khy');
    databases.push({
      name: 'sessions.db',
      path: path.join(khyDir, 'sessions.db'),
      critical: true,
    });
    databases.push({
      name: 'taskboard.db',
      path: path.join(khyDir, 'taskboard.db'),
      critical: true,
    });
  }

  return databases.filter(db => fs.existsSync(db.path));
}

// ── Integrity Check ──

/**
 * Run PRAGMA quick_check on a database.
 * Returns { ok: boolean, result: string, durationMs: number, error: string|null }
 */
function checkIntegrity(dbPath, opts = {}) {
  const started = Date.now();
  const result = {
    ok: false,
    result: 'not_checked',
    durationMs: 0,
    error: null,
  };

  let db = null;
  try {
    const Database = opts.DatabaseCtor || require('../config/sqlite-adapter');

    if (!fs.existsSync(dbPath)) {
      result.error = 'Database file does not exist';
      return result;
    }

    db = new Database(dbPath, { readonly: true });

    // Use quick_check for fast startup checks
    const checkResult = db.pragma('quick_check');
    const checkValue = Array.isArray(checkResult) && checkResult[0]
      ? String(checkResult[0].quick_check || checkResult[0])
      : 'unknown';

    result.result = checkValue;
    result.ok = checkValue === 'ok';

    if (!result.ok) {
      result.error = `Integrity check failed: ${checkValue}`;
    }

    return result;
  } catch (err) {
    result.error = `Integrity check error: ${err.message}`;
    return result;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
    result.durationMs = Date.now() - started;
  }
}

// ── Recovery Procedures ──

/**
 * Step A0: drop orphaned/mismatched WAL sidecars before touching the main file.
 *
 * External file surgery (mirror syncs, cloud-drive conflict copies, partial
 * archives) can leave a database paired with a -wal/-shm belonging to a
 * different database generation. SQLite then refuses to open the trio with
 * "file is not a database" even though the main file itself may be perfectly
 * healthy. Sidecars are derived state: quarantining them (renamed aside, never
 * deleted) lets SQLite rebuild them from the main file — the fastest cure, and
 * zero data loss whenever the main file is intact.
 */
function _tryResetSidecars(dbPath, dbName) {
  const sidecars = ['-wal', '-shm', '-journal']
    .map(suffix => `${dbPath}${suffix}`)
    .filter(file => fs.existsSync(file));

  if (sidecars.length === 0) {
    return { ok: false, reason: 'no sidecar files present' };
  }

  const stamp = Date.now();
  try {
    for (const file of sidecars) {
      _retryFsOperation(
        () => fs.renameSync(file, `${file}.orphan-${stamp}`),
        `quarantine sidecar ${path.basename(file)}`,
        { dbPath },
      );
    }
  } catch (err) {
    return {
      ok: false,
      reason: `sidecar quarantine failed: ${err.message}`,
      busy: _isBusyError(err),
    };
  }

  const check = checkIntegrity(dbPath);
  if (check.ok) {
    _logHealAudit({
      level: 'info',
      message: `修复数据库 ${dbName}(清理失配的 WAL 附属文件 ${sidecars.length} 个，主库完好)`,
      meta: { method: 'sidecar_reset', dbPath, dbName, quarantined: sidecars.length },
    });
    return { ok: true, method: 'sidecar_reset', quarantined: sidecars.length };
  }

  return {
    ok: false,
    reason: `main file still unhealthy after sidecar reset: ${check.error}`,
  };
}

/**
 * Step A: Try WAL checkpoint to recover from WAL-related issues.
 */
function _tryWalCheckpoint(dbPath) {
  let db = null;
  try {
    const Database = require('../config/sqlite-adapter');
    db = new Database(dbPath, { readonly: false });

    const journalMode = db.pragma('journal_mode');
    const mode = Array.isArray(journalMode) && journalMode[0]
      ? String(journalMode[0].journal_mode || journalMode[0])
      : 'unknown';

    if (mode !== 'wal') {
      return { ok: false, reason: 'not in WAL mode' };
    }

    // TRUNCATE mode aggressively reclaims WAL
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;

    // Verify integrity after checkpoint
    const check = checkIntegrity(dbPath);
    return { ok: check.ok, reason: check.ok ? 'WAL checkpoint successful' : check.error };
  } catch (err) {
    return { ok: false, reason: `WAL checkpoint failed: ${err.message}` };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

// Rowid probing: how far past the last sign of data to keep looking, and how
// long the whole probe may run before we settle for what we have.
const SALVAGE_ROWID_GAP = 256;
const SALVAGE_DEAD_RUN = 64;
const SALVAGE_TIME_BUDGET_MS = 20000;
// A corrupted header can advertise an absurd page count; refuse to allocate
// more than this when rebuilding a readable copy.
const SALVAGE_MAX_REPAIR_BYTES = 1024 * 1024 * 1024;

/**
 * Find the highest rowid the file still gives evidence of.
 *
 * A silent miss means the row genuinely is not there (deleted, or past the
 * end). An error means the b-tree walk hit a page that is gone — evidence that
 * rows once lived beyond this point, which is what the M of "recovered N/M"
 * has to account for. So probing continues past errors, and stops on either a
 * long run of silent misses (end of table) or a shorter run of errors (the
 * region is confirmed dead and its true extent is unknowable).
 */
function _probeMaxRowid(src, quoted, deadline) {
  try {
    const row = src.prepare(`SELECT MAX(rowid) AS m FROM ${quoted}`).get();
    if (row && Number.isFinite(row.m)) return row.m;
  } catch {
    // MAX(rowid) needs a page that is gone; fall back to probing.
  }

  const probe = src.prepare(`SELECT rowid AS r FROM ${quoted} WHERE rowid = ?`);
  let lastEvidence = 0;
  let missRun = 0;
  let deadRun = 0;

  for (let rid = 1; missRun < SALVAGE_ROWID_GAP && deadRun < SALVAGE_DEAD_RUN; rid++) {
    if (Date.now() > deadline) break;
    try {
      if (probe.get(rid)) {
        lastEvidence = rid;
        missRun = 0;
        deadRun = 0;
      } else {
        missRun++;
      }
    } catch {
      // A run of errors describes one unreadable region, not one proven row per
      // failed probe. Count its first rowid as the observable boundary; a later
      // readable row will advance the estimate and reset the run.
      if (deadRun === 0) lastEvidence = Math.max(lastEvidence, rid);
      deadRun++;
      missRun = 0;
    }
  }
  return lastEvidence;
}

/**
 * Copy as many rows of one table as the corrupted file still yields.
 * Returns { recovered, expected, skipped }.
 */
function _salvageTable(src, dst, table, deadline) {
  const quoted = `"${String(table).replace(/"/g, '""')}"`;

  let columns;
  try {
    columns = src.pragma(`table_info(${quoted})`).map(c => c.name);
  } catch (err) {
    return { recovered: 0, expected: 0, skipped: 0, note: `table_info failed: ${err.message}` };
  }
  if (columns.length === 0) {
    return { recovered: 0, expected: 0, skipped: 0, note: 'no columns' };
  }

  const colList = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');

  let insert;
  try {
    insert = dst.prepare(`INSERT OR IGNORE INTO ${quoted} (${colList}) VALUES (${placeholders})`);
  } catch (err) {
    return { recovered: 0, expected: 0, skipped: 0, note: `target not writable: ${err.message}` };
  }

  const toValues = row => columns.map(c => (row[c] === undefined ? null : row[c]));

  // Fast path: a full scan succeeds whenever corruption missed this table.
  try {
    const rows = src.prepare(`SELECT ${colList} FROM ${quoted}`).all();
    dst.transaction(rs => { for (const r of rs) insert.run(toValues(r)); })(rows);
    return { recovered: rows.length, expected: rows.length, skipped: 0 };
  } catch {
    // Scan died on a bad page — fall through and salvage row by row.
  }

  // WITHOUT ROWID tables cannot be stepped by rowid; the scan above was the
  // only option, so report the table as unsalvageable rather than looping.
  try {
    src.prepare(`SELECT rowid FROM ${quoted} LIMIT 1`).get();
  } catch (err) {
    if (/no such column|WITHOUT ROWID/i.test(err.message)) {
      return { recovered: 0, expected: 0, skipped: 0, note: 'WITHOUT ROWID table unreadable' };
    }
  }

  const maxRowid = _probeMaxRowid(src, quoted, deadline);
  const stepper = src.prepare(`SELECT ${colList} FROM ${quoted} WHERE rowid = ?`);
  let recovered = 0;
  let skipped = 0;

  for (let rid = 1; rid <= maxRowid; rid++) {
    if (Date.now() > deadline) {
      return { recovered, expected: maxRowid, skipped, note: 'salvage time budget exhausted' };
    }
    let row;
    try {
      row = stepper.get(rid);
    } catch {
      skipped++;
      continue;
    }
    if (!row) continue;
    try {
      insert.run(toValues(row));
      recovered++;
    } catch {
      skipped++;
    }
  }

  return { recovered, expected: maxRowid, skipped };
}

const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Make a truncated file readable enough to walk its schema, on a copy.
 *
 * A half-truncated database is rejected outright — even `SELECT ... FROM
 * sqlite_master` fails — because the header still advertises a page count and a
 * change counter that the shortened file contradicts. Nothing on page 1 is
 * necessarily damaged; SQLite just refuses to look. So this writes a copy that
 * is internally consistent again:
 *
 *   - grow back to the page count the header declares, zero-filling, so root
 *     pages that pointed into the lost tail resolve to empty pages instead of
 *     failing schema parse with "invalid rootpage"
 *   - offset 92 (version-valid-for) := 0, so it disagrees with the change
 *     counter and SQLite re-derives cached header state
 *   - offsets 18/19 (write/read version) := 1, detaching any stale WAL
 *   - offsets 32/36 (freelist) := 0, since the freelist chain may be severed
 *   - offset 52 (auto-vacuum root) := 0, since the pointer map may be severed too
 *
 * The rows themselves are still recovered page by page afterwards; this only
 * gets the door open. The original file is never touched.
 */
function _writeRepairedCopy(dbPath) {
  let raw;
  try {
    raw = fs.readFileSync(dbPath);
  } catch (err) {
    return { ok: false, reason: `unreadable: ${err.message}` };
  }

  if (raw.length < 100 || raw.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
    return { ok: false, reason: 'not a SQLite file header' };
  }

  const rawPageSize = raw.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    return { ok: false, reason: `implausible page size ${pageSize}` };
  }

  const havePages = Math.floor(raw.length / pageSize);
  if (havePages < 1) {
    return { ok: false, reason: 'file shorter than one page' };
  }

  const targetPages = Math.max(raw.readUInt32BE(28), havePages);
  if (targetPages * pageSize > SALVAGE_MAX_REPAIR_BYTES) {
    return { ok: false, reason: `header declares ${targetPages} pages, too large to rebuild` };
  }

  const repairedPath = `${dbPath}.hdrfix-${Date.now()}`;
  try {
    const out = Buffer.alloc(targetPages * pageSize);
    raw.subarray(0, havePages * pageSize).copy(out);
    out.writeUInt32BE(targetPages, 28);
    out.writeUInt32BE(0, 92);
    out.writeUInt8(1, 18);
    out.writeUInt8(1, 19);
    out.writeUInt32BE(0, 52);
    out.writeUInt32BE(0, 32);
    out.writeUInt32BE(0, 36);
    fs.writeFileSync(repairedPath, out);
  } catch (err) {
    try { fs.unlinkSync(repairedPath); } catch { /* ignore */ }
    return { ok: false, reason: `could not write repaired copy: ${err.message}` };
  }

  return { ok: true, path: repairedPath, pageSize, havePages, targetPages };
}

/**
 * Step B fallback: native salvage for when the sqlite3 CLI is unavailable.
 *
 * Reimplements what matters about `.recover` using only the SQLite driver the
 * app already links: read whatever the corrupted file still yields and write it
 * into a fresh database, skipping the pages that are gone. This is what makes
 * stage B reachable on machines without sqlite3 on PATH.
 */
function _tryNativeSalvage(dbPath) {
  const tmpPath = `${dbPath}.recovered-${Date.now()}`;
  const deadline = Date.now() + SALVAGE_TIME_BUDGET_MS;
  const Database = require('../config/sqlite-adapter');
  let src = null;
  let dst = null;
  let repairedPath = null;
  let via = 'native';

  const cleanupRepaired = () => {
    if (!repairedPath) return;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.unlinkSync(`${repairedPath}${suffix}`); } catch { /* ignore */ }
    }
    repairedPath = null;
  };

  try {
    const readSchema = handle => handle
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all();

    let objects;
    try {
      src = new Database(dbPath, { readonly: true });
      objects = readSchema(src);
    } catch (schemaErr) {
      // The file is damaged enough that SQLite will not even read its schema.
      // Retry against a header-repaired copy before giving up.
      try { if (src) src.close(); } catch { /* ignore */ }
      src = null;

      const repair = _writeRepairedCopy(dbPath);
      if (!repair.ok) {
        return { ok: false, reason: `schema unreadable (${schemaErr.message}); ${repair.reason}` };
      }
      repairedPath = repair.path;
      via = 'native+header-repair';

      try {
        src = new Database(repairedPath, { readonly: true });
        objects = readSchema(src);
      } catch (retryErr) {
        return {
          ok: false,
          reason: `schema unreadable even after header repair: ${retryErr.message}`,
        };
      }
    }

    const tables = objects.filter(o => o.type === 'table' && !/^sqlite_/.test(o.name));
    if (tables.length === 0) {
      return { ok: false, reason: 'no salvageable schema in sqlite_master' };
    }

    dst = new Database(tmpPath);
    dst.pragma('journal_mode = WAL');

    for (const t of tables) {
      try {
        dst.exec(t.sql);
      } catch {
        // Unusable definition; its rows will be reported as unsalvaged.
      }
    }

    let recovered = 0;
    let expected = 0;
    const perTable = [];

    for (const t of tables) {
      const stats = _salvageTable(src, dst, t.name, deadline);
      recovered += stats.recovered;
      expected += stats.expected;
      perTable.push({ table: t.name, ...stats });
    }

    // Indexes, views and triggers go on last, once the rows are in place.
    for (const o of objects) {
      if (o.type === 'table') continue;
      try {
        dst.exec(o.sql);
      } catch {
        // Constraint that the salvaged subset cannot satisfy — skip it.
      }
    }

    dst.close();
    dst = null;
    src.close();
    src = null;

    if (recovered === 0) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, reason: 'salvage produced no rows' };
    }

    const check = checkIntegrity(tmpPath);
    if (!check.ok) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, reason: `salvaged database failed integrity check: ${check.error}` };
    }

    return {
      ok: true,
      recoveredPath: tmpPath,
      recordCount: recovered,
      expectedCount: Math.max(expected, recovered),
      perTable,
      via,
      reason: `Salvaged ${recovered}/${Math.max(expected, recovered)} rows without the sqlite3 CLI`,
    };
  } catch (err) {
    try { if (dst) { dst.close(); dst = null; } } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, reason: `native salvage failed: ${err.message}` };
  } finally {
    try { if (src) src.close(); } catch { /* ignore */ }
    try { if (dst) dst.close(); } catch { /* ignore */ }
    // The header-repaired copy is scaffolding, never a result.
    cleanupRepaired();
  }
}

/**
 * Estimate how many rows the corrupted source *should* hold, so the audit line
 * can report "recovered N/M". Counts what is readable and, for tables whose
 * pages are damaged, the highest rowid the file still gives evidence of.
 */
function _estimateSourceRowCount(dbPath) {
  let src = null;
  try {
    const Database = require('../config/sqlite-adapter');
    src = new Database(dbPath, { readonly: true });
    const tables = src
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    const deadline = Date.now() + SALVAGE_TIME_BUDGET_MS;
    let total = 0;
    for (const t of tables) {
      const quoted = `"${String(t.name).replace(/"/g, '""')}"`;
      try {
        const row = src.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get();
        total += row.c || 0;
      } catch {
        total += _probeMaxRowid(src, quoted, deadline);
      }
    }
    return total;
  } catch {
    return null;
  } finally {
    try { if (src) src.close(); } catch { /* ignore */ }
  }
}

/**
 * Step B: extract whatever data the corrupted file still yields.
 *
 * Prefers the sqlite3 CLI's `.recover`, which understands more damage cases
 * than a driver-level read can. When the CLI is not installed the native
 * salvage above takes over, so this stage never depends on an external binary
 * being on PATH.
 */
async function _tryRecover(dbPath) {
  const cliResult = await _tryRecoverViaCli(dbPath);
  if (cliResult.ok) return cliResult;

  _logHealAudit({
    level: 'warn',
    message: `sqlite3 CLI .recover unavailable or failed (${cliResult.reason}), falling back to native salvage`,
    meta: { dbPath },
  });

  const nativeResult = _tryNativeSalvage(dbPath);
  if (nativeResult.ok) return nativeResult;

  return {
    ok: false,
    reason: `cli: ${cliResult.reason}; native: ${nativeResult.reason}`,
  };
}

/**
 * Step B (preferred path): `sqlite3 corrupted.db .recover | sqlite3 recovered.db`.
 */
function _tryRecoverViaCli(dbPath) {
  return new Promise((resolve) => {
    const tmpRecoveredPath = `${dbPath}.recovered-${Date.now()}`;

    try {
      // Check if sqlite3 CLI is available
      const sqlite3Cmd = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3';

      // Run: sqlite3 corrupted.db ".recover" | sqlite3 recovered.db
      const recover = spawn(sqlite3Cmd, [dbPath, '.recover']);
      const rebuild = spawn(sqlite3Cmd, [tmpRecoveredPath]);

      let recovered = false;
      let resolved = false;
      let errorOutput = '';
      let timeoutHandle = null;

      function resolveOnce(result) {
        if (!resolved) {
          resolved = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(result);
        }
      }

      // Handle spawn errors (e.g., sqlite3.exe not in PATH). The caller logs
      // the fallback to native salvage, so stay quiet here.
      recover.on('error', () => {
        resolveOnce({ ok: false, reason: 'sqlite3-not-found' });
      });

      rebuild.on('error', () => {
        resolveOnce({ ok: false, reason: 'sqlite3-not-found' });
      });

      // A dead pipe (the peer process never started) must not crash the app.
      recover.stdout.on('error', () => {});
      rebuild.stdin.on('error', () => {});
      recover.stdout.pipe(rebuild.stdin);

      recover.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      rebuild.on('close', (code) => {
        if (code !== 0 || !fs.existsSync(tmpRecoveredPath)) {
          resolveOnce({ ok: false, reason: errorOutput || 'sqlite3 .recover failed' });
          return;
        }

        if (fs.statSync(tmpRecoveredPath).size === 0) {
          try { fs.unlinkSync(tmpRecoveredPath); } catch { /* ignore */ }
          resolveOnce({ ok: false, reason: 'Recovered database is empty' });
          return;
        }

        const check = checkIntegrity(tmpRecoveredPath);
        if (!check.ok) {
          try { fs.unlinkSync(tmpRecoveredPath); } catch { /* ignore */ }
          resolveOnce({
            ok: false,
            reason: `Recovered database failed integrity check: ${check.error}`,
          });
          return;
        }

        let recordCount = 0;
        try {
          const Database = require('../config/sqlite-adapter');
          const db = new Database(tmpRecoveredPath, { readonly: true });
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all();
          for (const t of tables) {
            const quoted = `"${String(t.name).replace(/"/g, '""')}"`;
            const count = db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get();
            recordCount += count.c || 0;
          }
          db.close();
        } catch {
          /* ignore — recordCount stays at what was counted */
        }

        const expectedCount = _estimateSourceRowCount(dbPath);

        recovered = true;
        clearTimeout(timeoutHandle);
        resolveOnce({
          ok: true,
          recoveredPath: tmpRecoveredPath,
          recordCount,
          expectedCount: Math.max(expectedCount || 0, recordCount),
          via: 'cli',
          reason: 'Successfully recovered data',
        });
      });

      // Timeout after 30 seconds
      timeoutHandle = setTimeout(() => {
        if (!recovered) {
          recover.kill();
          rebuild.kill();
          if (fs.existsSync(tmpRecoveredPath)) {
            try { fs.unlinkSync(tmpRecoveredPath); } catch { /* ignore */ }
          }
          resolveOnce({ ok: false, reason: 'Recovery timeout (30s)' });
        }
      }, 30000);
    } catch (err) {
      resolve({ ok: false, reason: `Recovery setup failed: ${err.message}` });
    }
  });
}

/**
 * Use a filesystem-safe stem for backup names. Known database labels may carry
 * a relative prefix (for example `khy-Trajectory/sessions.db`).
 */
function _backupStem(dbName) {
  return path.basename(dbName, path.extname(dbName));
}

/**
 * Step C: Try restoring from most recent backup.
 */
function _tryRestoreFromBackup(dbPath, dbName) {
  try {
    // Recovery checkpoints and clean-shutdown backups are separate stores. Scan
    // both so step C honours `.khy/checkpoints` while retaining compatibility
    // with the shutdown snapshots written beside each database.
    const candidateDirs = [
      path.join(path.dirname(dbPath), 'checkpoints'),
      path.join(process.cwd(), '.khy', 'checkpoints'),
      path.join(path.dirname(dbPath), 'db_backup'),
    ].filter((dir, index, dirs) => dirs.indexOf(dir) === index && fs.existsSync(dir));

    if (candidateDirs.length === 0) {
      return { ok: false, reason: 'No backup directory found' };
    }

    const pattern = new RegExp(`^${_backupStem(dbName)}\\.(\\d{4}-\\d{2}-\\d{2}T[\\d-]+)\\.db$`);
    const backups = candidateDirs
      .flatMap(dir => fs.readdirSync(dir).map(file => ({ dir, file })))
      .map(candidate => {
        const match = candidate.file.match(pattern);
        return match ? { ...candidate, timestamp: match[1] } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (backups.length === 0) {
      return { ok: false, reason: 'No backups found' };
    }

    const failures = [];
    for (const backup of backups) {
      const backupPath = path.join(backup.dir, backup.file);
      const backupCheck = checkIntegrity(backupPath);
      if (!backupCheck.ok) {
        failures.push(`${backup.file}: ${backupCheck.error}`);
        continue;
      }

      const restoreResult = restoreSqliteInPlace(backupPath, dbPath);
      if (!restoreResult.ok) {
        failures.push(`${backup.file}: ${restoreResult.error}`);
        continue;
      }

      return {
        ok: true,
        backupTimestamp: backup.timestamp,
        reason: `Restored from backup: ${backup.file}`,
      };
    }

    return { ok: false, reason: `No valid backup found: ${failures.join('; ')}` };
  } catch (err) {
    return { ok: false, reason: `Backup restore failed: ${err.message}` };
  }
}

/**
 * Step D: Rebuild empty database as last resort.
 */
function _rebuildEmptyDatabase(dbPath, dbName) {
  try {
    // Back up the corrupted file for forensics
    const corruptedBackup = `${dbPath}.corrupted-${Date.now()}`;
    try {
      fs.copyFileSync(dbPath, corruptedBackup);
    } catch {
      /* ignore */
    }

    // Remove corrupted files; on a busy error ask the daemon to release its
    // handles first, then make one final removal pass.
    const removeCorruptedFiles = () => {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const file = `${dbPath}${suffix}`;
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
    };
    try {
      removeCorruptedFiles();
    } catch (removeErr) {
      if (!_isBusyError(removeErr)) throw removeErr;
      _releaseKhyDbLocks(dbPath);
      removeCorruptedFiles();
    }

    // Let the application recreate the schema on next access
    return {
      ok: true,
      reason: 'Rebuilt empty database (schema will be recreated on next access)',
    };
  } catch (err) {
    return { ok: false, reason: `Rebuild failed: ${err.message}` };
  }
}

/**
 * Orchestrate multi-stage recovery for a corrupted database.
 */
async function healDatabase(dbPath, dbName) {
  _logHealAudit({
    level: 'warn',
    message: `Starting recovery for ${dbName}`,
    meta: { dbPath },
  });

  // Step A0: mismatched WAL sidecars (external overwrite / sync accidents).
  const sidecarResult = _tryResetSidecars(dbPath, dbName);
  if (sidecarResult.ok) {
    return { ok: true, method: sidecarResult.method, quarantined: sidecarResult.quarantined };
  }
  if (sidecarResult.reason !== 'no sidecar files present') {
    _logHealAudit({
      level: 'warn',
      message: `Sidecar reset did not heal ${dbName}: ${sidecarResult.reason}`,
      meta: { dbPath, dbName, stage: 'sidecar_reset' },
    });
  }

  // Step A: WAL checkpoint
  const walResult = _tryWalCheckpoint(dbPath);
  if (walResult.ok) {
    _logHealAudit({
      level: 'info',
      message: `修复数据库 ${dbName}(WAL checkpoint)`,
      meta: { method: 'wal_checkpoint', dbPath, dbName },
    });
    return { ok: true, method: 'wal_checkpoint' };
  }

  _logHealAudit({
    level: 'warn',
    message: `WAL checkpoint failed for ${dbName}: ${walResult.reason}`,
    meta: { dbPath, dbName, stage: 'wal_checkpoint' },
  });

  // Step B: .recover command
  const recoverResult = await _tryRecover(dbPath);
  if (recoverResult.ok) {
    // Replace corrupted database with recovered one
    try {
      const recovered = recoverResult.recordCount;
      const expected = Math.max(recoverResult.expectedCount || 0, recovered);

      const swapInRecovered = () => {
        _retryFsOperation(
          () => fs.renameSync(dbPath, `${dbPath}.corrupted-${Date.now()}`),
          'move corrupted database aside',
          { dbPath },
        );
        fs.renameSync(recoverResult.recoveredPath, dbPath);
        // The salvaged file carries no sidecars; drop the corrupted ones so the
        // next open does not replay a WAL belonging to the old file.
        for (const suffix of ['-wal', '-shm', '-journal']) {
          try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* ignore */ }
        }
      };

      try {
        swapInRecovered();
      } catch (swapErr) {
        if (!_isBusyError(swapErr)) throw swapErr;
        // A sibling khy process (usually the daemon) still holds the old
        // handle — ask it to release, then give the swap one final window.
        _releaseKhyDbLocks(dbPath);
        swapInRecovered();
      }

      _logHealAudit({
        level: 'info',
        message: `修复数据库 ${dbName}(recover 模式，恢复 ${recovered}/${expected} 条记录)`,
        meta: {
          method: 'recover',
          via: recoverResult.via,
          recordCount: recovered,
          expectedCount: expected,
          dbPath,
          dbName,
        },
      });
      return {
        ok: true,
        method: 'recover',
        via: recoverResult.via,
        recordCount: recovered,
        expectedCount: expected,
      };
    } catch (err) {
      _logHealAudit({
        level: 'error',
        message: `Failed to replace database after recovery: ${err.message}`,
        meta: { dbPath, dbName, stage: 'recover' },
      });
    }
  }

  _logHealAudit({
    level: 'warn',
    message: `.recover failed for ${dbName}: ${recoverResult.reason}`,
    meta: { dbPath, dbName, stage: 'recover' },
  });

  // Step C: Restore from backup. A first failure that smells like a file lock
  // gets one retry after asking the daemon to release its handles.
  let backupResult = _tryRestoreFromBackup(dbPath, dbName);
  if (!backupResult.ok && _isBusyError(backupResult.reason)) {
    _releaseKhyDbLocks(dbPath);
    backupResult = _tryRestoreFromBackup(dbPath, dbName);
  }
  if (backupResult.ok) {
    _logHealAudit({
      level: 'info',
      message: `从备份恢复 ${dbName}，备份时间 ${backupResult.backupTimestamp}`,
      meta: { method: 'backup_restore', backupTimestamp: backupResult.backupTimestamp, dbPath, dbName },
    });
    return { ok: true, method: 'backup_restore', backupTimestamp: backupResult.backupTimestamp };
  }

  _logHealAudit({
    level: 'warn',
    message: `Backup restore failed for ${dbName}: ${backupResult.reason}`,
    meta: { dbPath, dbName, stage: 'backup_restore' },
  });

  // Step D: Rebuild empty database
  const rebuildResult = _rebuildEmptyDatabase(dbPath, dbName);
  if (rebuildResult.ok) {
    _logHealAudit({
      level: 'error',
      message: `All recovery methods failed for ${dbName}, rebuilt empty database`,
      meta: { method: 'rebuild_empty', dbPath, dbName },
    });

    // Notify user (if notification system is available)
    _notifyUser(`Database ${dbName} was corrupted and all recovery attempts failed. An empty database has been created. Previous data may be lost.`);

    return { ok: true, method: 'rebuild_empty', dataLoss: true };
  }

  _logHealAudit({
    level: 'error',
    message: `Complete failure to heal ${dbName}: ${rebuildResult.reason}`,
  });

  // L1(本函数的四步阶梯)全败 —— 交给升级链收尾。重建空库(= dbHealth 的 L2 手段)刚刚
  // 已在 Step D 亲自跑过并失败,故 skipL2:true,不重复做无用功,直接进 L3:写
  // .khy/heal_escalation.json + 终端告警,让人知道该做什么(而不是静默返回 {ok:false})。
  // fail-soft:升级链自身出问题绝不改变本函数的返回值。
  try {
    await require('./healEscalationService').escalate({
      component: 'dbHealth',
      trigger: 'db-health-heal',
      skipL2: true,
      context: { dbPath, dbName },
      failedAttempts: [
        { step: 'wal_checkpoint', error: walResult.reason || 'failed' },
        { step: 'recover', error: recoverResult.reason || 'failed' },
        { step: 'backup_restore', error: backupResult.reason || 'failed' },
        { step: 'rebuild_empty', error: rebuildResult.reason || 'failed' },
      ],
    });
  } catch {
    /* 升级链绝不能反过来搞垮自愈 */
  }

  return { ok: false, error: rebuildResult.reason };
}

function _notifyUser(message) {
  const logger = _getLogger();
  logger.error(`[DB Health Alert] ${message}`);

  // Could integrate with notification system here
  try {
    const notificationService = require('./notificationService');
    if (notificationService && typeof notificationService.sendAlert === 'function') {
      notificationService.sendAlert('Database Corruption', message);
    }
  } catch {
    /* notification system not available */
  }
}

// ── Startup Check ──

/**
 * Check integrity of all known databases at startup.
 * Automatically attempts recovery if corruption is detected.
 */
async function startupIntegrityCheck() {
  _knownDatabases = _discoverDatabases();

  _logHealAudit({
    level: 'info',
    message: `Starting integrity check for ${_knownDatabases.length} databases`,
    meta: { databases: _knownDatabases.map(d => d.name) },
  });

  const results = [];

  for (const db of _knownDatabases) {
    const check = checkIntegrity(db.path);

    if (check.ok) {
      _logHealAudit({
        level: 'info',
        message: `✓ ${db.name} integrity check passed (${check.durationMs}ms)`,
      });
      results.push({ name: db.name, ok: true });
    } else {
      _logHealAudit({
        level: 'error',
        message: `✗ ${db.name} integrity check failed: ${check.error}`,
        meta: { durationMs: check.durationMs },
      });

      // Attempt healing
      const healResult = await healDatabase(db.path, db.name);
      results.push({
        name: db.name,
        ok: healResult.ok,
        healed: true,
        method: healResult.method,
        dataLoss: healResult.dataLoss || false,
      });
    }
  }

  return results;
}

// ── Periodic Maintenance ──

/**
 * Start periodic WAL checkpoint to prevent unbounded growth.
 */
function startPeriodicMaintenance() {
  if (_checkpointTimer) {
    clearInterval(_checkpointTimer);
  }

  _checkpointTimer = setInterval(() => {
    _performPeriodicCheckpoint();
  }, WAL_CHECKPOINT_INTERVAL_MS);

  // Don't keep the process alive just for this timer
  if (_checkpointTimer.unref) {
    _checkpointTimer.unref();
  }

  _logHealAudit({
    level: 'info',
    message: `Periodic WAL checkpoint started (interval: 6h)`,
  });
}

function _performPeriodicCheckpoint(databases = _knownDatabases) {
  const results = [];
  for (const db of databases) {
    try {
      const Database = require('../config/sqlite-adapter');
      const conn = new Database(db.path, { readonly: false });

      const journalMode = conn.pragma('journal_mode');
      const mode = Array.isArray(journalMode) && journalMode[0]
        ? String(journalMode[0].journal_mode || journalMode[0])
        : 'unknown';

      if (mode === 'wal') {
        const checkpoint = conn.pragma('wal_checkpoint(PASSIVE)');

        // Check WAL size
        const walPath = `${db.path}-wal`;
        if (fs.existsSync(walPath)) {
          const walSize = fs.statSync(walPath).size;
          const dbSize = fs.statSync(db.path).size;
          const ratio = dbSize > 0 ? walSize / dbSize : 0;

          if (ratio > 3) {
            _logHealAudit({
              level: 'warn',
              message: `WAL file for ${db.name} is ${ratio.toFixed(1)}x larger than database; truncating`,
              meta: { dbPath: db.path, dbName: db.name, walSize, dbSize, ratio },
            });
            conn.pragma('wal_checkpoint(TRUNCATE)');
          }
        }
        const finalWalSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
        results.push({ name: db.name, ok: true, mode, checkpoint, finalWalSize });
      } else {
        results.push({ name: db.name, ok: true, mode, skipped: true });
      }

      conn.close();
    } catch (err) {
      _logHealAudit({
        level: 'warn',
        message: `Periodic checkpoint failed for ${db.name}: ${err.message}`,
      });
      results.push({ name: db.name, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Stop periodic maintenance (call on shutdown).
 */
function stopPeriodicMaintenance() {
  if (_checkpointTimer) {
    clearInterval(_checkpointTimer);
    _checkpointTimer = null;
  }
}

// ── Shutdown Backup ──

/**
 * Create backup copies of all databases on clean shutdown.
 * Keeps the 3 most recent backups per database.
 */
async function shutdownBackup(databases = _knownDatabases, now = new Date()) {
  _logHealAudit({
    level: 'info',
    message: 'Creating shutdown backups',
  });

  const results = [];

  for (const db of databases) {
    try {
      const backupDir = path.join(path.dirname(db.path), 'db_backup');
      fs.mkdirSync(backupDir, { recursive: true });

      const timestamp = now.toISOString().replace(/:/g, '-').split('.')[0];
      const backupName = `${_backupStem(db.name)}.${timestamp}.db`;
      const backupPath = path.join(backupDir, backupName);

      const copyResult = hotCopySqlite(db.path, backupPath);

      if (copyResult.ok) {
        _logHealAudit({
          level: 'info',
          message: `✓ Backed up ${db.name} (${copyResult.bytes} bytes, ${copyResult.durationMs}ms)`,
          meta: { backupPath, journalMode: copyResult.journalMode },
        });

        // Clean up old backups (keep only 3 most recent)
        _pruneOldBackups(backupDir, db.name);

        results.push({ name: db.name, ok: true });
      } else {
        _logHealAudit({
          level: 'error',
          message: `✗ Failed to backup ${db.name}: ${copyResult.error}`,
        });
        results.push({ name: db.name, ok: false, error: copyResult.error });
      }
    } catch (err) {
      _logHealAudit({
        level: 'error',
        message: `Backup error for ${db.name}: ${err.message}`,
      });
      results.push({ name: db.name, ok: false, error: err.message });
    }
  }

  return results;
}

function _pruneOldBackups(backupDir, dbName) {
  try {
    const files = fs.readdirSync(backupDir);
    const pattern = new RegExp(`^${_backupStem(dbName)}\\.(.*)\\.db$`);
    const backups = files
      .map(f => {
        const match = f.match(pattern);
        if (!match) return null;
        const fullPath = path.join(backupDir, f);
        const stats = fs.statSync(fullPath);
        return { file: f, path: fullPath, mtime: stats.mtime.getTime() };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    // Keep only MAX_BACKUPS_TO_KEEP most recent
    const toDelete = backups.slice(MAX_BACKUPS_TO_KEEP);
    for (const backup of toDelete) {
      fs.unlinkSync(backup.path);
      _logHealAudit({
        level: 'info',
        message: `Pruned old backup: ${backup.file}`,
      });
    }
  } catch (err) {
    _logHealAudit({
      level: 'warn',
      message: `Failed to prune old backups: ${err.message}`,
    });
  }
}

// ── Public API ──

/**
 * Initialize the database health service.
 * Should be called at application startup.
 */
async function init(options = {}) {
  _consoleLoggingEnabled = options.silentConsole !== true;
  _logHealAudit({
    level: 'info',
    message: 'Initializing database health service',
  });

  const checkResults = await startupIntegrityCheck();
  startPeriodicMaintenance();

  // Register shutdown hook with centralized shutdown manager
  try {
    const { addShutdownHook } = require('../bootstrap/shutdown');
    addShutdownHook('db-health-service', shutdown);
  } catch {
    // shutdown module not available — shutdown() must be called manually
  }

  return { ok: true, databases: checkResults };
}

/**
 * Shutdown hook for the database health service.
 * Should be called on clean application shutdown.
 */
async function shutdown() {
  stopPeriodicMaintenance();
  const backupResults = await shutdownBackup();

  _logHealAudit({
    level: 'info',
    message: 'Database health service shutdown complete',
  });

  return { ok: true, backups: backupResults };
}

/**
 * Get the heal audit log (for debugging/monitoring).
 */
function getAuditLog() {
  return [..._healAuditLog];
}

/**
 * Manually trigger integrity check and healing for a specific database.
 */
async function checkAndHeal(dbPath) {
  const check = checkIntegrity(dbPath);
  if (check.ok) {
    return { ok: true, healed: false, message: 'Database is healthy' };
  }

  const dbName = path.basename(dbPath);
  const healResult = await healDatabase(dbPath, dbName);
  return { ...healResult, healed: true };
}

module.exports = {
  init,
  shutdown,
  checkIntegrity,
  healDatabase,
  checkAndHeal,
  getAuditLog,
  startPeriodicMaintenance,
  stopPeriodicMaintenance,
  shutdownBackup,
  _performPeriodicCheckpoint,
  // 内部(healEscalationService 的 dbHealth L2 手段复用同一实现,避免重建/通知逻辑分叉)
  _rebuildEmptyDatabase,
  _notifyUser,
  // 内部(锁感知自愈原语,导出仅供测试)
  _isBusyError,
  _retryFsOperation,
  _releaseKhyDbLocks,
  _tryResetSidecars,
};
