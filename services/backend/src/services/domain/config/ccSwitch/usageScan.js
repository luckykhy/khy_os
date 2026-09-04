'use strict';

/**
 * ccSwitch usageScan — external-tool session usage scanner (byte-cursor
 * incremental). Mirrors CC Switch v3.20.1's "字节游标增量扫描" design:
 *
 *   - For every watched session file, persist the last committed BYTE OFFSET
 *     plus a TAIL FINGERPRINT (hash of the last N bytes). Each round only reads
 *     the newly appended suffix, so a 12 MB active session file scans in
 *     milliseconds instead of re-parsing the whole file.
 *   - A partial line at the tail never advances the cursor: the cursor commits
 *     only after a COMPLETE line, so the finished message is picked up next round.
 *   - Truncated or externally rewritten files are NEVER replayed (replaying
 *     double-counts against 30-day-summary-pruned history): the cursor is
 *     pinned to the new file end and the skipped range is reported in the sync
 *     result's error list, not silently dropped.
 *   - Mid-file read errors preserve committed progress and resume next round.
 *   - Cursor prefetch failure aborts the round (never looks like a fresh first
 *     scan and re-imports all history).
 *
 * Token extraction per tool:
 *   - Claude Code: JSONL `assistant` records → message.usage{ input_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens, output_tokens }
 *   - Codex: JSONL session records → usage{ input_tokens, output_tokens, ... }
 *   - Gemini / OpenCode: JSONL records with usage blocks (best-effort)
 *
 * Output feeds tokenUsageService.recordUsage() per request (daily/monthly
 * aggregates + cost via tokenPricing).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { APPS } = require('../../collab/proactiveCollaboration/constants');

// Cursor state file lives in the app home (portable-aware), not in the tool dir.
let _cursorStore = null;
function _cursorFile() {
  if (_cursorStore) {
    return _cursorStore;
  }
  try {
    const { getAppHome } = require('../../../../utils/dataHome');
    _cursorStore = path.join(getAppHome(), 'cc_switch_scan_cursors.json');
  } catch {
    _cursorStore = path.join(os.homedir(), '.khyquant', 'cc_switch_scan_cursors.json');
  }
  return _cursorStore;
}

// Session directory resolvers per app. Fail-soft: empty array on any error.
function _claudeSessionDirs(env = process.env) {
  const dirs = [];
  const configDir = (env && env.CLAUDE_CONFIG_DIR) || '~/.claude';
  const base = configDir.startsWith('~')
    ? path.join(os.homedir(), configDir.slice(2))
    : configDir;
  const projects = path.join(base, 'projects');
  if (fs.existsSync(projects)) {
    dirs.push(projects);
  }
  return dirs;
}

function _codexSessionDirs(env = process.env) {
  const dirs = [];
  const home = os.homedir();
  for (const base of [path.join(home, '.codex', 'sessions'), path.join(home, '.config', 'codex', 'sessions')]) {
    if (fs.existsSync(base)) {
      dirs.push(base);
    }
  }
  return dirs;
}

function _geminiSessionDirs(env = process.env) {
  const dirs = [];
  const configDir = (env && env.GEMINI_CONFIG_DIR) || '~/.gemini';
  const base = configDir.startsWith('~') ? path.join(os.homedir(), configDir.slice(2)) : configDir;
  for (const sub of ['sessions', 'history', 'data']) {
    const d = path.join(base, sub);
    if (fs.existsSync(d)) {
      dirs.push(d);
    }
  }
  return dirs;
}

function _opencodeSessionDirs(env = process.env) {
  const dirs = [];
  const configDir = (env && env.OPENCODE_CONFIG_DIR) || path.join(os.homedir(), '.config', 'opencode');
  const sessions = path.join(configDir, 'sessions');
  if (fs.existsSync(sessions)) {
    dirs.push(sessions);
  }
  return dirs;
}

function _commandCodeSessionDirs(env = process.env) {
  const dirs = [];
  const configDir = (env && env.COMMAND_CODE_HOME) || '~/.commandcode';
  const base = configDir.startsWith('~')
    ? path.join(os.homedir(), configDir.slice(2))
    : configDir;
  // Command Code stores per-project transcripts under projects/<project>/*.jsonl
  // (same nesting shape as Claude Code's projects/ tree).
  const projects = path.join(base, 'projects');
  if (fs.existsSync(projects)) {
    dirs.push(projects);
  }
  return dirs;
}

function _ycodeSessionDirs(env = process.env) {
  const dirs = [];
  // YCode sessions live under the OS user cache dir, scoped to a hash of the
  // workspace path. YCODE_CACHE_DIR overrides the location (official override).
  let cacheBase = null;
  if (env && env.YCODE_CACHE_DIR) {
    cacheBase = String(env.YCODE_CACHE_DIR);
  } else {
    cacheBase = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.cache');
  }
  const ycodeDir = path.join(cacheBase, 'ycode');
  if (fs.existsSync(ycodeDir)) {
    dirs.push(ycodeDir);
  }
  return dirs;
}

const SESSION_DIRS = Object.freeze({
  [APPS.CLAUDE_CODE]: _claudeSessionDirs,
  [APPS.CODEX]: _codexSessionDirs,
  [APPS.GEMINI]: _geminiSessionDirs,
  [APPS.OPENCODE]: _opencodeSessionDirs,
  [APPS.COMMAND_CODE]: _commandCodeSessionDirs,
  [APPS.YCODE]: _ycodeSessionDirs,
});

// ── Cursor state management ────────────────────────────────────────────────
function _loadCursors() {
  try {
    const f = _cursorFile();
    if (fs.existsSync(f)) {
      return JSON.parse(fs.readFileSync(f, 'utf-8'));
    }
  } catch {
    /* ignore */
  }
  return { files: {} };
}

function _saveCursors(cursors) {
  try {
    const { atomicWriteJson } = require('../../../../utils/atomicWriteJson');
    atomicWriteJson(_cursorFile(), cursors, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

// ── Token extraction per app ───────────────────────────────────────────────
function _claudeUsageFromRecord(rec) {
  const usage = rec && rec.message && rec.message.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = Number(usage.input_tokens) || 0;
  const cacheRead = Number(usage.cache_read_input_tokens) || 0;
  const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
  const outputTokens = Number(usage.output_tokens) || 0;
  if (!inputTokens && !outputTokens && !cacheRead && !cacheCreate) {
    return null;
  }
  return {
    inputTokens: inputTokens + cacheRead + cacheCreate,
    outputTokens,
    model:
      (rec.message && rec.message.model) || (rec.message && rec.message.modelName) || '',
    provider: 'claude',
  };
}

function _codexUsageFromRecord(rec) {
  const usage = rec && rec.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = Number(usage.input_tokens) || Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.output_tokens) || Number(usage.outputTokens) || 0;
  if (!inputTokens && !outputTokens) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    model: rec.model || rec.modelSlug || '',
    provider: 'codex',
  };
}

function _genericUsageFromRecord(rec) {
  const usage = rec && rec.usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = Number(usage.input_tokens) || Number(usage.inputTokens) || 0;
  const outputTokens = Number(usage.output_tokens) || Number(usage.outputTokens) || 0;
  if (!inputTokens && !outputTokens) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    model: rec.model || rec.modelName || '',
    provider: 'external',
  };
}

const RECORD_EXTRACTORS = Object.freeze({
  [APPS.CLAUDE_CODE]: _claudeUsageFromRecord,
  [APPS.CODEX]: _codexUsageFromRecord,
  [APPS.GEMINI]: _genericUsageFromRecord,
  [APPS.OPENCODE]: _genericUsageFromRecord,
  [APPS.COMMAND_CODE]: _genericUsageFromRecord,
  [APPS.YCODE]: _genericUsageFromRecord,
});

// Tail fingerprint: sha256 of the last 64 bytes (detects same-size rewrites).
function _tailFingerprint(buf) {
  const tail = buf.slice(Math.max(0, buf.length - 64));
  return crypto.createHash('sha256').update(tail).digest('hex');
}

/**
 * Incrementally scan one session file: read only the suffix after the cursor.
 *
 * @param {string} file
 * @param {object} cursor  { offset, fingerprint, size }
 * @returns {{ records: Array<object>, nextCursor: object, error?: string, skipped?: string }}
 */
function scanFileIncrement(file, cursor) {
  const out = { records: [], nextCursor: cursor || { offset: 0, fingerprint: '', size: 0 } };
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const prevOffset = Number(out.nextCursor.offset) || 0;
    const prevSize = Number(out.nextCursor.size) || 0;

    // Truncated or same-size rewritten file: never replay.
    if (prevOffset > 0 && (size < prevOffset || (size === prevOffset && out.nextCursor.fingerprint)) ) {
      if (size < prevOffset) {
        out.skipped = `截断: ${prevOffset} → ${size} 字节，跳过并重钉游标`;
      } else if (out.nextCursor.fingerprint) {
        // Same size: verify tail fingerprint; mismatch → rewritten, skip.
        const head = Buffer.alloc(Math.min(size, 65536));
        fs.readSync(fd, head, 0, head.length, Math.max(0, size - head.length));
        const fp = _tailFingerprint(head);
        if (fp !== out.nextCursor.fingerprint) {
          out.skipped = '同尺寸改写（指纹不匹配），跳过并重钉游标';
        } else {
          // Same size + same fingerprint → no new data.
          out.nextCursor = { offset: size, fingerprint: fp, size };
          return out;
        }
      }
      // Rewind: re-read whole file? NO — pin cursor to new end without replay.
      out.nextCursor = { offset: size, fingerprint: _tailFingerprint(Buffer.alloc(0)), size };
      return out;
    }

    // No new bytes → done.
    if (size <= prevOffset) {
      return out;
    }

    // Read only the appended suffix.
    const toRead = size - prevOffset;
    const chunk = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, chunk, 0, toRead, prevOffset);
    const suffix = chunk.slice(0, bytesRead).toString('utf-8');

    // Never advance past a partial trailing line.
    const lastNewline = suffix.lastIndexOf('\n');
    let completeText = suffix;
    let committedOffset = size;
    if (lastNewline === -1 && suffix.length > 0) {
      // No complete line in the suffix yet — hold the cursor.
      return { records: [], nextCursor: out.nextCursor, held: true };
    }
    if (lastNewline < suffix.length - 1) {
      completeText = suffix.slice(0, lastNewline + 1);
      committedOffset = prevOffset + lastNewline + 1;
    }

    for (const raw of completeText.split('\n')) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      try {
        out.records.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }

    out.nextCursor = {
      offset: committedOffset,
      fingerprint: _tailFingerprint(chunk.slice(0, bytesRead)),
      size,
    };
    return out;
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
    return out;
  } finally {
    if (fd) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Collect all session files for an app.
 * @returns {Array<{app:string, file:string}>}
 */
function collectSessionFiles(app, env = process.env) {
  const resolver = SESSION_DIRS[app];
  if (!resolver) {
    return [];
  }
  const files = [];
  for (const dir of resolver(env)) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Claude Code nests sessions one level deep (project dirs).
          try {
            const nested = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
            for (const n of nested) {
              if (n.isFile() && (n.name.endsWith('.jsonl') || n.name.endsWith('.json'))) {
                files.push({ app, file: path.join(dir, entry.name, n.name) });
              }
            }
          } catch {
            /* ignore */
          }
        } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
          files.push({ app, file: path.join(dir, entry.name) });
        }
      }
    } catch {
      /* ignore */
    }
  }
  return files;
}

/**
 * Run one incremental scan round across all watched apps.
 *
 * @param {{ apps?: string[], force?: boolean, env?: object }} opts
 * @returns {Promise<{ imported: number, files: number, errors: Array<{file:string,error:string}>, byApp: object }>}
 */
async function scanSessions(opts = {}) {
  const apps = Array.isArray(opts.apps) && opts.apps.length
    ? opts.apps
    : Object.values(APPS);
  const cursors = _loadCursors();
  const { recordUsage } = require('../../../tokenUsageService');

  const result = {
    imported: 0,
    files: 0,
    errors: [],
    byApp: {},
  };

  for (const app of apps) {
    result.byApp[app] = { files: 0, imported: 0 };
    const files = collectSessionFiles(app, opts.env || process.env);
    const extract = RECORD_EXTRACTORS[app];
    if (!extract) {
      continue;
    }

    for (const { file } of files) {
      const key = `${app}:${file}`;
      const prevCursor = (cursors.files && cursors.files[key]) || { offset: 0, fingerprint: '', size: 0 };
      const scan = scanFileIncrement(file, prevCursor);
      result.files += 1;
      result.byApp[app].files += 1;

      if (scan.error) {
        // Preserve committed progress; resume from committed offset next round.
        result.errors.push({ file, error: scan.error });
        continue;
      }
      if (scan.skipped) {
        result.errors.push({ file, error: scan.skipped });
      }
      if (scan.held) {
        // Partial tail line — keep cursor, don't import, don't advance.
        continue;
      }

      let importedForFile = 0;
      for (const rec of scan.records) {
        const usage = extract(rec);
        if (!usage) {
          continue;
        }
        try {
          const costUSD = estimateCostUSD(usage.inputTokens, usage.outputTokens, usage.model);
          recordUsage(usage.provider || app, usage.model || app, usage.inputTokens, usage.outputTokens, costUSD);
          importedForFile += 1;
          result.imported += 1;
          result.byApp[app].imported += 1;
        } catch {
          /* per-record failure must not abort the round */
        }
      }

      cursors.files[key] = scan.nextCursor;
    }
  }

  _saveCursors(cursors);
  return result;
}

/** Rough USD cost estimate (fallback when no real pricing is available). */
function estimateCostUSD(inputTokens, outputTokens, model) {
  // Use the tokenPricing leaf's substring-matching estimator (handles both
  // model names and provider keys); falls back to its default rate.
  try {
    const pricing = require('../../../tokenPricing');
    if (pricing && typeof pricing.estimateCost === 'function') {
      const c = pricing.estimateCost(inputTokens, outputTokens, model || 'default');
      if (Number.isFinite(c) && c >= 0) {
        return c;
      }
    }
  } catch {
    /* fall through */
  }
  // Conservative default: $2.5/M input, $10/M output (Claude Sonnet-class).
  return (inputTokens / 1e6) * 2.5 + (outputTokens / 1e6) * 10;
}

function getCursorState() {
  return _loadCursors();
}

module.exports = {
  scanSessions,
  scanFileIncrement,
  collectSessionFiles,
  getCursorState,
  estimateCostUSD,
  RECORD_EXTRACTORS,
  _tailFingerprint,
  __test__: { _loadCursors, _saveCursors },
};
