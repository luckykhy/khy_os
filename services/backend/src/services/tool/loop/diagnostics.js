'use strict';

/**
 * loop/diagnostics.js — self-contained loop observability helpers, carved out of
 * toolUseLoopCore.js (T-021 god-file split, pure-leaf slice).
 *
 *   - _loopBreadcrumb   opt-in (KHY_LOOP_DEBUG) WHY-a-turn-happened trail, appended to
 *                       a FILE (never stdout/stderr, so it can't corrupt the TUI region);
 *                       owns its lazy path cache _loopDebugFile.
 *   - _getHookSystem    lazy, memoised cli/hooks/hookSystem handle (auto-init built-in
 *                       ToolGuards); owns its tri-state cache _hookSystem (undefined=
 *                       not-yet-loaded, null=unavailable, else the module).
 *   - _fileContentHash  md5 of a file's first 10KB for edit-staleness detection.
 *
 * All three are module-PRIVATE in the core (never exported) and each owns its own
 * module-level cache. Pure leaf: only built-ins (fs/path/crypto) + one LAZY require
 * re-based for this dir — NO core back-edge (M6 cycles stay 0). The core re-requires
 * + rebinds the three names so the ~80 in-body _loopBreadcrumb call sites, the two
 * `loopBreadcrumb: _loopBreadcrumb` DI passes and the _getHookSystem/_fileContentHash
 * call sites are all byte-identical.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Loop breadcrumb (opt-in via KHY_LOOP_DEBUG) ──────────────────────────
// Records WHY the tool-use loop ran an extra model turn after a no-tool reply
// (which nudge fired, or that the model itself attached a trailing tool_use to
// a substantive answer). Used to diagnose the "answer finished but spinner
// still 思考中" symptom. Disabled by default — writes nothing unless the flag is
// set. Appends to a FILE (never stdout/stderr) so it can't corrupt the TUI's
// live region. Inspect with: tail -f "$KHY_LOOP_DEBUG_FILE" (default
// <tmpdir>/khy-loop-debug.log).
let _loopDebugFile = null;
function _loopBreadcrumb(event, data) {
  if (!process.env.KHY_LOOP_DEBUG || process.env.KHY_LOOP_DEBUG === '0') {
    return;
  }
  try {
    if (_loopDebugFile === null) {
      _loopDebugFile =
        process.env.KHY_LOOP_DEBUG_FILE || path.join(require('os').tmpdir(), 'khy-loop-debug.log');
    }
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n';
    fs.appendFileSync(_loopDebugFile, line);
  } catch {
    /* breadcrumb is best-effort; never throw into the loop */
  }
}

// Hook system (lazy-loaded, auto-initializes with built-in ToolGuards)
let _hookSystem = undefined; // undefined = not yet loaded, null = unavailable
function _getHookSystem() {
  if (_hookSystem !== undefined) {
    return _hookSystem;
  }

  try {
    const hs = require('../../../cli/hooks/hookSystem');
    // Auto-initialize if not yet done (registers built-in guards)
    if (typeof hs.isInitialized === 'function' && !hs.isInitialized()) {
      hs.init(process.env.KHYQUANT_CWD || process.cwd());
    }
    // Return hookSystem if any hooks (including built-in guards) are registered
    _hookSystem = hs.registry && hs.registry.count > 0 ? hs : null;
  } catch {
    _hookSystem = null;
  }
  return _hookSystem;
}

// ── Content-fingerprint guard (staleness detection for edits) ─────
function _fileContentHash(filePath) {
  try {
    const buf = Buffer.alloc(10240);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buf, 0, 10240, 0);
    fs.closeSync(fd);
    return crypto.createHash('md5').update(buf.slice(0, bytesRead)).digest('hex');
  } catch {
    return null;
  }
}

module.exports = {
  _loopBreadcrumb,
  _getHookSystem,
  _fileContentHash,
};
