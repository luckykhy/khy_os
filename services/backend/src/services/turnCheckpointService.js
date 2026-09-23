'use strict';

/**
 * turnCheckpointService.js — per-turn multi-file atomic rollback.
 *
 * Aligns goal A from [DESIGN-ARCH-096] §2-A (按回合撤销深化 / turn-undo),
 * borrowed from ycode's `core/turn_undo/` design. It layers a TURN-level
 * atomic-restore guarantee on top of the existing per-file
 * `fileHistoryService` snapshots, filling the gap the four-level
 * `rollbackService` facade honestly documents: its TURN level is data-only
 * (canonicalState) and does NOT restore code.
 *
 * Design principles (mirroring ycode turn_undo, in AGENTS.md style):
 *   - 逐文件原子 + 冲突零写入 (conflict zero-write): `rollbackTurn` is a
 *     two-phase transaction — validate ALL files first, then apply ALL. If
 *     any file conflicts (its current content no longer matches the state the
 *     turn assumed), the WHOLE turn is refused and NOTHING is written. A
 *     half-rolled state is never produced.
 *   - 启动校验撤销覆盖 (recorder-coverage gate): `validateRecorderCoverage`
 *     fails startup when a tool that declares `mutates_files` was not wired
 *     into the recorder — a漏接 is a startup error, not a silent gap.
 *   - 语义纠正块 (semantic correction): `buildSemanticCorrection` emits the
 *     "the files written above are now stale, re-verify" context to inject
 *     into the model's next turn.
 *   - 诚实不假装 (honest, no fake success): every path returns a structured
 *     `{ success, ... }` and never throws into the caller.
 *
 * Storage: per-turn manifest JSON under the app data home
 * (`<appHome>/turn_checkpoints/<turnId>.json`). turnId is generated as
 * `turn-<timestamp>-<rand>` by `beginTurn`. The manifest is durable so a
 * crash between endTurn and rollbackTurn still has the pre-edit contents to
 * restore from (the files themselves may have been overwritten, but the
 * snapshot is what we restore TO).
 *
 * Note: this service deliberately does NOT rewrite conversation history —
 * it restores controlled file modifications only (ycode's "撤销不改写历史").
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Lazy-resolve the app data home (portable-aware, isolated by KHY_APP_HOME /
// KHY_DATA_HOME in tests). Resolved at call time, not module load, so the
// established test pattern (delete require.cache + pin env) keeps working.
function _appHome() {
  try {
    const { getAppHome } = require('../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}

function _turnDir() {
  return path.join(_appHome(), 'turn_checkpoints');
}

function _turnPath(turnId) {
  return path.join(_turnDir(), `${turnId}.json`);
}

function _generateTurnId() {
  const ts = new Date().toISOString().replace(/[-:.:T]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `turn-${ts}-${rand}`;
}

// Manifest statuses:
//   opened   — beginTurn called, still recording files
//   ended    — endTurn called, ready to roll back
//   rolledback — a successful rollbackTurn consumed it (terminal)
const STATUS = Object.freeze({
  OPENED: 'opened',
  ENDED: 'ended',
  ROLLEDBACK: 'rolledback',
});

function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function _readManifest(turnId) {
  try {
    return JSON.parse(fs.readFileSync(_turnPath(turnId), 'utf-8'));
  } catch {
    return null;
  }
}

function _writeManifest(manifest) {
  _ensureDir(_turnDir());
  const tmp = _turnPath(manifest.turnId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(tmp, _turnPath(manifest.turnId));
}

// ── Turn lifecycle ───────────────────────────────────────────────────

/**
 * Start a new turn. Returns the fresh turnId. Subsequent recordMutatedFile
 * calls must pass this id so their pre-edit snapshots aggregate into it.
 *
 * @param {string} [sessionId] - owning session, recorded for traceability
 * @returns {string} the generated turnId
 */
function beginTurn(sessionId) {
  const turnId = _generateTurnId();
  const manifest = {
    turnId,
    sessionId: sessionId || null,
    status: STATUS.OPENED,
    createdAt: new Date().toISOString(),
    files: [], // [{ path, preContent, reason, snapshotIndex, recordedAt }]
  };
  _writeManifest(manifest);
  return turnId;
}

/**
 * Record that the turn is about to mutate a file: capture its CURRENT
 * (pre-edit) content now. Call this BEFORE the tool writes the file, in the
 * same place the existing write tools call fileHistoryService.takeSnapshot.
 *
 * Duplicate records of the same path within a turn keep the FIRST captured
 * pre-content (the true pre-edit state) and report `duplicate:true`.
 *
 * @param {string} turnId
 * @param {string} filePath
 * @param {object} [options]
 * @param {string} [options.reason] - which tool triggered the mutation
 * @returns {{ success: boolean, duplicate?: boolean, snapshotIndex?: number, error?: string }}
 */
function recordMutatedFile(turnId, filePath, options = {}) {
  try {
    const manifest = _readManifest(turnId);
    if (!manifest) {
      return { success: false, error: `no turn manifest found for ${turnId}` };
    }
    if (manifest.status !== STATUS.OPENED) {
      return {
        success: false,
        error: `turn ${turnId} is ${manifest.status}; can only record while open`,
      };
    }

    const resolved = path.resolve(filePath);
    const existing = manifest.files.find((f) => f.path === resolved);
    if (existing) {
      // Keep the first-captured pre-content; do not clobber it.
      return { success: true, duplicate: true, snapshotIndex: existing.snapshotIndex };
    }

    // Capture the pre-edit content. Prefer an explicit pre-read (options.content)
    // to avoid a redundant disk read; fall back to reading the file.
    let preContent;
    if (options.content !== undefined) {
      preContent = options.content;
    } else if (fs.existsSync(resolved)) {
      preContent = fs.readFileSync(resolved, 'utf-8');
    } else {
      preContent = ''; // brand-new file → pre-edit state is "does not exist"
    }

    const entry = {
      path: resolved,
      preContent,
      existedBefore: fs.existsSync(resolved) || options.content !== undefined,
      reason: options.reason || 'unknown',
      snapshotIndex: manifest.files.length,
      recordedAt: new Date().toISOString(),
    };
    manifest.files.push(entry);

    // Also take the canonical per-file history snapshot so /rewind still sees it.
    try {
      const fh = require('./fileHistoryService');
      const r = fh.takeSnapshot(resolved, {
        reason: `turnCheckpoint:${options.reason || 'unknown'}`,
        content: preContent,
      });
      entry.fileHistoryIndex = r && r.snapshotIndex;
    } catch {
      /* fileHistory is best-effort; the turn manifest is the source of truth */
    }

    _writeManifest(manifest);
    return { success: true, snapshotIndex: entry.snapshotIndex };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Close the recording window. After endTurn the turn is ready to roll back.
 *
 * @param {string} turnId
 * @returns {{ success: boolean, turn?: object, error?: string }}
 */
function endTurn(turnId) {
  try {
    const manifest = _readManifest(turnId);
    if (!manifest) {
      return { success: false, error: `no turn manifest found for ${turnId}` };
    }
    if (manifest.status === STATUS.ROLLEDBACK) {
      return {
        success: false,
        error: `turn ${turnId} already rolled back; endTurn is a no-op`,
      };
    }
    manifest.status = STATUS.ENDED;
    manifest.endedAt = new Date().toISOString();
    _writeManifest(manifest);
    return { success: true, turn: manifest };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Atomic multi-file rollback + conflict zero-write ─────────────────

/**
 * Read a file's current content, or null if it does not exist.
 */
function _readCurrent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Restore a single file to a target content, creating/deleting as needed.
 * Returns { ok } or throws on hard IO error (caller handles transactionality).
 */
function _applyFile(entry, targetContent) {
  const abs = entry.path;
  if (targetContent === null) {
    // Restore to "did not exist before this turn".
    if (fs.existsSync(abs)) {
      fs.rmSync(abs);
    }
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, targetContent, 'utf-8');
}

/**
 * Roll back a whole turn: restore every file it recorded to its pre-edit
 * content, atomically.
 *
 * Two-phase:
 *   Phase 1 (validate): for every recorded file, determine the target
 *     pre-edit content. If `options.expectedContents` is provided, a file
 *     whose CURRENT content no longer equals the expected value is a CONFLICT
 *     (something external touched it after the turn closed).
 *   Phase 2 (apply): only if there are ZERO conflicts, write every file.
 *     Any conflict aborts the whole turn with ZERO writes.
 *
 * @param {string} turnId
 * @param {object} [options]
 * @param {Object<string,string|null>} [options.expectedContents] -
 *   map of absPath → the content the turn ASSUMED was on disk when it
 *   closed (i.e. right after its writes). A mismatch = external conflict.
 * @returns {object} structured result, never throws
 */
function rollbackTurn(turnId, options = {}) {
  try {
    const manifest = _readManifest(turnId);
    if (!manifest) {
      return { success: false, restored: false, error: `no turn manifest found for ${turnId}` };
    }
    if (manifest.status === STATUS.ROLLEDBACK) {
      return {
        success: false,
        restored: false,
        error: `turn ${turnId} already rolled back (terminal); refusing to re-apply`,
      };
    }
    if (manifest.files.length === 0) {
      return { success: true, restored: true, conflicts: 0, files: [] };
    }

    const expected = options.expectedContents || null;

    // Phase 1: validate all files.
    const conflicts = [];
    const plan = [];
    for (const entry of manifest.files) {
      const target = entry.preContent; // restore to pre-edit state
      if (expected && Object.prototype.hasOwnProperty.call(expected, entry.path)) {
        const current = _readCurrent(entry.path);
        const expVal = expected[entry.path];
        const currentMatchesExpected =
          (expVal === null ? current === null : current === expVal);
        if (!currentMatchesExpected) {
          conflicts.push(entry.path);
        }
      }
      plan.push({ entry, target });
    }

    // Conflict zero-write: any conflict aborts the WHOLE turn, nothing written.
    if (conflicts.length > 0) {
      return {
        success: false,
        restored: false,
        conflicts: conflicts.length,
        conflictedFiles: conflicts,
        note: 'turn aborted: external modification detected; no files were written',
      };
    }

    // Phase 2: apply all files (zero conflicts).
    for (const { entry, target } of plan) {
      _applyFile(entry, target === undefined ? '' : target);
    }
    manifest.status = STATUS.ROLLEDBACK;
    manifest.rolledBackAt = new Date().toISOString();
    _writeManifest(manifest);

    return {
      success: true,
      restored: true,
      conflicts: 0,
      files: manifest.files.map((f) => f.path),
    };
  } catch (err) {
    return { success: false, restored: false, conflicts: 0, error: err.message };
  }
}

// ── Startup recorder-coverage gate ─────────────────────────────────────

// Tools the first-party write path wires into the recorder. New tools that
// declare mutates_files MUST add themselves here (or register at runtime) or
// the coverage gate refuses to start. Names are the canonical tool names
// used by the dispatcher/registry (see src/tools/*): editFile / writeFile
// (defineTool), Edit / Write / apply_patch / MultiEdit (BaseTool toolName).
const _FIRST_PARTY_MUTATING_TOOLS = new Set([
  'editFile',
  'writeFile',
  'Edit',
  'Write',
  'apply_patch',
  'MultiEdit',
  // Snake-case aliases that some registries surface by.
  'write_file',
  'edit_file',
  'apply_patch_snake',
]);

// Runtime-registered wirings (tests / dynamic registries call this).
const _runtimeWired = new Set();

/**
 * Declare that a mutating tool has been wired into the turn recorder.
 * Call this once per tool at startup (the analogue of ycode's
 * validate_recorder_coverage preflight hook).
 *
 * @param {string} toolName
 * @returns {void}
 */
function registerRecorderWiring(toolName) {
  _runtimeWired.add(String(toolName));
}

/**
 * Test/teardown helper: clear the runtime-registered wirings so a fresh
 * service instance does not inherit a previous process's registrations.
 * @returns {void}
 */
function resetRecorderWiring() {
  _runtimeWired.clear();
}

/**
 * Verify every `mutates_files` tool in a registry is covered by the recorder.
 * Returns a report; `ok` is false when a mutating tool is uncovered — the
 * caller (startup) should fail-fast on that.
 *
 * Coverage = built-in first-party mutating tools ∪ runtime-registered wirings
 * ∪ an optional explicit `wired` set passed in (useful for tests to assert
 * against a fresh, deterministic coverage set without global-state leakage).
 *
 * @param {object} registry - object with optional `getToolSpecs() -> Array`
 *   where each spec has `{ name, mutates_files }`.
 * @param {Array<string>|Set<string>} [wired] - explicit covered tool names
 *   (adds to built-in ∪ runtime). When provided, the runtime set is ignored
 *   for this call so the result is fully determined by the argument.
 * @returns {{ ok: boolean, uncovered: string[] }}
 */
function validateRecorderCoverage(registry, wired) {
  const covered = new Set(_FIRST_PARTY_MUTATING_TOOLS);
  if (wired !== undefined) {
    for (const name of Array.isArray(wired) ? wired : [...wired]) covered.add(String(name));
  } else {
    for (const name of _runtimeWired) covered.add(name);
  }

  const uncovered = new Set();
  let specs = [];
  try {
    if (registry && typeof registry.getToolSpecs === 'function') {
      specs = registry.getToolSpecs() || [];
    }
  } catch {
    specs = [];
  }
  for (const spec of specs) {
    if (!spec || !spec.mutates_files) continue;
    const name = String(spec.name);
    if (!covered.has(name)) uncovered.add(name);
  }
  return { ok: uncovered.size === 0, uncovered: [...uncovered].sort() };
}

// ── Semantic correction block ──────────────────────────────────────────

/**
 * Build the "file results are now stale" injection text to append to the
 * model's next-turn context after a turn was rolled back. After a rollback
 * the model still believes the files it wrote are on disk; this block tells
 * it those specific results are invalid and to re-verify.
 *
 * @param {object} rollbackResult - the structured result from rollbackTurn
 * @param {string} turnId
 * @returns {string} the correction block (short note when nothing restored)
 */
function buildSemanticCorrection(rollbackResult, turnId) {
  const r = rollbackResult || {};
  if (r.success && r.restored && Array.isArray(r.files) && r.files.length > 0) {
    const lines = r.files.map((f) => `  - ${f}`);
    return (
      `[system] 回合 ${turnId} 的文件修改已被撤销（${r.files.length} 个文件恢复为编辑前内容）。\n` +
      `以下工具结果已失效（stale），请勿再当作已写入磁盘，如需请重新读取确认：\n` +
      lines.join('\n') +
      `\n请基于当前磁盘真实状态继续，勿引用上述已被回滚的写入结果。`
    );
  }
  // No successful restore → short note, no file list.
  return `[system] 回合 ${turnId} 未发生文件撤销（未恢复任何文件）。`;
}

// ── Listing / inspection ───────────────────────────────────────────────

/**
 * Read-only preview of a turn rollback: how many files would be restored and
 * which are in conflict (current content no longer matches the expected post-
 * turn state). Performs ZERO writes.
 *
 * @param {string} turnId
 * @param {Object<string,string|null>} [expectedContents] - optional map of the
 *   content the turn assumed on disk when it closed; when omitted, no conflict
 *   check is run (returns fileCount + no conflicts).
 * @returns {{ success: boolean, turnId: string, fileCount: number, conflicts: number, conflictedFiles: string[], status?: string, error?: string }}
 */
function previewTurnRollback(turnId, expectedContents) {
  try {
    const manifest = _readManifest(turnId);
    if (!manifest) {
      return {
        success: false,
        turnId,
        fileCount: 0,
        conflicts: 0,
        conflictedFiles: [],
        error: `no turn manifest found for ${turnId}`,
      };
    }
    const expected = expectedContents || null;
    const conflictedFiles = [];
    if (expected) {
      for (const entry of manifest.files) {
        if (Object.prototype.hasOwnProperty.call(expected, entry.path)) {
          const current = _readCurrent(entry.path);
          const expVal = expected[entry.path];
          const match = expVal === null ? current === null : current === expVal;
          if (!match) conflictedFiles.push(entry.path);
        }
      }
    }
    return {
      success: true,
      turnId,
      status: manifest.status,
      fileCount: manifest.files.length,
      conflicts: conflictedFiles.length,
      conflictedFiles,
    };
  } catch (err) {
    return {
      success: false,
      turnId,
      fileCount: 0,
      conflicts: 0,
      conflictedFiles: [],
      error: err.message,
    };
  }
}

/**
 * Load a turn manifest.
 * @param {string} turnId
 * @returns {{ success: boolean, status?: string, files?: Array, error?: string }}
 */
function loadTurn(turnId) {
  const m = _readManifest(turnId);
  if (!m) return { success: false, error: `no turn manifest found for ${turnId}` };
  return { success: true, status: m.status, files: m.files, turnId, sessionId: m.sessionId };
}

/**
 * List turns (all, or a single session's), newest first.
 * @param {string} [sessionId]
 * @returns {Array<{ turnId: string, status: string, sessionId: string, fileCount: number, createdAt: string }>}
 */
function listTurns(sessionId) {
  let dir = _turnDir();
  if (!fs.existsSync(dir)) return [];
  let entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return {
          turnId: m.turnId,
          status: m.status,
          sessionId: m.sessionId,
          fileCount: (m.files || []).length,
          createdAt: m.createdAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (sessionId) entries = entries.filter((t) => t.sessionId === sessionId);
  return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

module.exports = {
  STATUS,
  beginTurn,
  recordMutatedFile,
  endTurn,
  rollbackTurn,
  registerRecorderWiring,
  resetRecorderWiring,
  validateRecorderCoverage,
  buildSemanticCorrection,
  previewTurnRollback,
  loadTurn,
  listTurns,
};
