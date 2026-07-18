'use strict';

/**
 * rollbackService.js — Four-level rollback facade (A2 可逆 / reversibility).
 *
 * Learned from DesireCore (Agent OS): reversibility is a first-class OS
 * property, graded by blast radius. Rather than inventing new storage, this
 * facade routes a single `snapshot`/`rollback`/`list` request to the existing
 * lower-level module that already owns that granularity:
 *
 *   granularity  backend module              what it captures        SLA target
 *   ───────────  ──────────────────────────  ──────────────────────  ──────────
 *   patch        fileHistoryService          one file's content      < 100ms
 *   turn         canonicalState              one turn's agent state  < 500ms
 *   session      checkpointService git-diff  working-tree diff/stash  < 2s
 *   version      checkpointService tar-full  full snapshot tarball   any
 *
 * Notes / honest constraints:
 *   - canonicalState has NO in-place restore: turn-level rollback returns the
 *     loaded snapshot data for the caller to re-inject, with restored:false.
 *   - The three persistent backends currently store under ~/.khyquant (legacy);
 *     they are not migrated here to avoid breaking existing data. The facade is
 *     purely a router and adds no new storage root.
 *
 * Every delegation is wrapped so a missing/erroring backend degrades to a
 * structured `{ success:false, error }` rather than throwing into the caller.
 */

const GRANULARITY = Object.freeze({
  PATCH: 'patch',
  TURN: 'turn',
  SESSION: 'session',
  VERSION: 'version',
});

// Advisory SLA targets (ms) — surfaced in results for observability, not enforced.
const SLA_MS = Object.freeze({ patch: 100, turn: 500, session: 2000, version: Infinity });

function _fileHistory() { return require('./fileHistoryService'); }
function _canonicalState() { return require('./canonicalState'); }
function _checkpoints() { return require('./workspace/checkpointService'); }

function _fail(error) { return { success: false, error: String(error) }; }

// ── Snapshot (capture a restore point) ───────────────────────────────

/**
 * Capture a restore point at the given granularity.
 *
 * @param {object} opts
 * @param {string} opts.granularity      patch|turn|session|version
 * @param {string} [opts.filePath]       (patch) file to snapshot
 * @param {string} [opts.content]        (patch) pre-read content to avoid re-read
 * @param {string} [opts.reason]         (patch) annotation
 * @param {object} [opts.ctx]            (turn) canonicalState.buildSnapshot context
 * @param {string} [opts.sessionId]      (turn) session key
 * @param {string} [opts.projectDir]     (session/version) project directory
 * @param {string} [opts.message]        (session/version) checkpoint message
 * @returns {object} backend result + { granularity, slaMs }
 */
function snapshot(opts = {}) {
  const g = opts.granularity;
  try {
    switch (g) {
      case GRANULARITY.PATCH: {
        if (!opts.filePath) return _fail('patch snapshot requires filePath');
        const r = _fileHistory().takeSnapshot(opts.filePath, {
          reason: opts.reason, content: opts.content,
        });
        return { ...r, granularity: g, slaMs: SLA_MS.patch };
      }
      case GRANULARITY.TURN: {
        const cs = _canonicalState();
        const state = cs.buildSnapshot(opts.ctx || {});
        cs.save(state, opts.sessionId || 'default');
        return { success: true, granularity: g, slaMs: SLA_MS.turn, snapshot: state };
      }
      case GRANULARITY.SESSION:
      case GRANULARITY.VERSION: {
        if (!opts.projectDir) return _fail(`${g} snapshot requires projectDir`);
        const mode = g === GRANULARITY.VERSION ? 'tar-full' : 'git-diff';
        const entry = _checkpoints().saveCheckpoint(opts.projectDir, {
          message: opts.message || `${g} snapshot`, mode,
        });
        return { success: true, granularity: g, slaMs: SLA_MS[g], checkpoint: entry };
      }
      default:
        return _fail(`unknown granularity: ${g}`);
    }
  } catch (err) {
    return _fail(err.message);
  }
}

// ── Rollback (restore a captured point) ──────────────────────────────

/**
 * Restore to a previously captured point.
 *
 * @param {object} opts
 * @param {string} opts.granularity      patch|turn|session|version
 * @param {string} [opts.filePath]       (patch) file to restore
 * @param {number} [opts.snapshotIndex]  (patch) target index; omit → undo last
 * @param {string} [opts.sessionId]      (turn) session key to load
 * @param {string} [opts.projectDir]     (session/version) project directory
 * @param {string} [opts.checkpointId]   (session/version) checkpoint id
 * @param {boolean} [opts.dryRun]        (session/version) preview only
 * @returns {object} { success, restored, ... }
 */
function rollback(opts = {}) {
  const g = opts.granularity;
  try {
    switch (g) {
      case GRANULARITY.PATCH: {
        if (!opts.filePath) return _fail('patch rollback requires filePath');
        const fh = _fileHistory();
        const r = (opts.snapshotIndex != null)
          ? fh.rewindTo(opts.filePath, opts.snapshotIndex)
          : fh.undoLast(opts.filePath);
        return { ...r, restored: !!r.success, granularity: g };
      }
      case GRANULARITY.TURN: {
        // canonicalState exposes no in-place restore — return the data so the
        // caller can re-inject it into the next turn's carry-forward prompt.
        const state = _canonicalState().load(opts.sessionId || 'default');
        if (!state) return { success: false, restored: false, granularity: g, error: 'no turn snapshot' };
        return {
          success: true,
          restored: false,
          granularity: g,
          snapshot: state,
          note: 'turn state loaded; re-inject via canonicalState.formatAsPrompt',
        };
      }
      case GRANULARITY.SESSION:
      case GRANULARITY.VERSION: {
        if (!opts.projectDir || !opts.checkpointId) {
          return _fail(`${g} rollback requires projectDir and checkpointId`);
        }
        const r = _checkpoints().restoreCheckpoint(opts.projectDir, opts.checkpointId, {
          dryRun: !!opts.dryRun,
        });
        return { success: true, restored: !opts.dryRun, granularity: g, ...r };
      }
      default:
        return _fail(`unknown granularity: ${g}`);
    }
  } catch (err) {
    return _fail(err.message);
  }
}

/**
 * Convenience: undo the most recent edit to a file (patch-level). When no
 * filePath is given, undo the most recently tracked file in this session.
 *
 * @param {object} [opts]
 * @param {string} [opts.filePath]
 * @returns {object} rollback result
 */
function undo(opts = {}) {
  try {
    let filePath = opts.filePath;
    if (!filePath) {
      const tracked = _fileHistory().listTrackedFiles();
      if (!tracked || tracked.length === 0) return _fail('no tracked files to undo');
      filePath = tracked[0].filePath; // newest first
    }
    return rollback({ granularity: GRANULARITY.PATCH, filePath });
  } catch (err) {
    return _fail(err.message);
  }
}

// ── List restore points ──────────────────────────────────────────────

/**
 * List available restore points at a granularity.
 *
 * @param {object} opts
 * @param {string} opts.granularity   patch|turn|session|version
 * @param {string} [opts.filePath]    (patch) specific file; omit → tracked files
 * @param {string} [opts.sessionId]   (turn)
 * @param {string} [opts.projectDir]  (session/version)
 * @returns {object} { success, granularity, items }
 */
function list(opts = {}) {
  const g = opts.granularity;
  try {
    switch (g) {
      case GRANULARITY.PATCH: {
        const fh = _fileHistory();
        if (opts.filePath) {
          const h = fh.getHistory(opts.filePath);
          const items = h ? h.snapshots.map((s, i) => ({
            index: i, timestamp: s.timestamp, reason: s.reason,
          })) : [];
          return { success: true, granularity: g, items };
        }
        return { success: true, granularity: g, items: fh.listTrackedFiles() };
      }
      case GRANULARITY.TURN: {
        const state = _canonicalState().load(opts.sessionId || 'default');
        return { success: true, granularity: g, items: state ? [state] : [] };
      }
      case GRANULARITY.SESSION:
      case GRANULARITY.VERSION: {
        if (!opts.projectDir) return _fail(`${g} list requires projectDir`);
        const all = _checkpoints().listCheckpoints(opts.projectDir);
        const want = g === GRANULARITY.VERSION ? 'tar-full' : null;
        const items = want ? all.filter(c => c.mode === want) : all;
        return { success: true, granularity: g, items };
      }
      default:
        return _fail(`unknown granularity: ${g}`);
    }
  } catch (err) {
    return _fail(err.message);
  }
}

module.exports = {
  GRANULARITY,
  SLA_MS,
  snapshot,
  rollback,
  undo,
  list,
};
