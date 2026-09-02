'use strict';

/**
 * tasteWatchService.js — passive, per-turn preference harvester.
 *
 * Hooked from `aiChatCore.chat()` end-of-turn. After every successful chat,
 * the (user, assistant) pair is fed through `crossAgentTasteLearner.learnFromRecord`
 * and any candidate above the floor is committed to tasteService.addPreference —
 * no separate `khy taste learn` run needed. Watch is OFF by default; flip via
 * `khy taste watch --on`.
 *
 * Design:
 *  - State file: ~/.khyos/cache/taste-watch.json (single tiny JSON).
 *  - Memory: per-process LRU dedup (`_seenKeys`) keyed by (category, normalized
 *    text). TTL 30 min. Prevents the same preference from being re-evaluated
 *    100x in a row during a long session.
 *  - Cache write: state file only re-written when enabled flag changes or every
 *    ~30s on stat rotation. Avoids fs IO per turn.
 *  - Failure surface: every external call is try/catch'd. observeTurn never
 *    throws — chat return must not be affected.
 *  - Pure-leaf: no IO at import time. The cache is lazy.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE_NAME = 'taste-watch.json';
const SEEN_TTL_MS = 30 * 60 * 1000;       // 30 min
const SEEN_CAP = 1000;                    // hard cap on dedup map
const STATS_WRITE_INTERVAL_MS = 30 * 1000; // 30 s

// ── State file (lazy) ────────────────────────────────────────────────────

function _cacheDir() {
  try {
    const { getBaseDataDir } = require('../utils/dataHome');
    return getBaseDataDir('cache');
  } catch {
    return path.join(os.homedir(), '.khyos', 'cache');
  }
}

function _stateFile() {
  return path.join(_cacheDir(), STATE_FILE_NAME);
}

function _defaultState() {
  return {
    enabled: false,
    updatedAt: new Date().toISOString(),
    stats: { observedTurns: 0, committed: 0, skippedSeen: 0, errors: 0 },
  };
}

let _stateCache = null;
let _stateMtimeMs = 0;

function _readState() {
  const file = _stateFile();
  try {
    const st = fs.statSync(file);
    if (_stateCache && st.mtimeMs === _stateMtimeMs) {
      return _stateCache;
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    _stateCache = Object.assign(_defaultState(), parsed, {
      stats: Object.assign(_defaultState().stats, parsed.stats || {}),
    });
    _stateMtimeMs = st.mtimeMs;
    return _stateCache;
  } catch {
    _stateCache = _defaultState();
    _stateMtimeMs = 0;
    return _stateCache;
  }
}

let _lastStatsWriteAt = 0;
function _writeState({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - _lastStatsWriteAt < STATS_WRITE_INTERVAL_MS) {
    return;
  }
  _lastStatsWriteAt = now;
  if (!_stateCache) return;
  _stateCache.updatedAt = new Date().toISOString();
  const file = _stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_stateCache, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    try {
      _stateMtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      /* best effort */
    }
  } catch {
    /* state file IO is best-effort */
  }
}

// ── Per-process dedup (LRU + TTL) ────────────────────────────────────────

const _seenKeys = new Map(); // key → { ts, count }

function _dedupKey(category, text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '')
    .trim();
  return `${category}::${norm}`;
}

function _isSeenFresh(key) {
  const now = Date.now();
  const entry = _seenKeys.get(key);
  if (!entry) return false;
  if (now - entry.ts > SEEN_TTL_MS) {
    _seenKeys.delete(key);
    return false;
  }
  return true;
}

function _markSeen(key) {
  const now = Date.now();
  if (_seenKeys.has(key)) {
    const entry = _seenKeys.get(key);
    entry.ts = now;
    entry.count += 1;
  } else {
    if (_seenKeys.size >= SEEN_CAP) {
      // LRU drop: delete oldest insertion (Map preserves insertion order).
      const oldest = _seenKeys.keys().next().value;
      if (oldest !== undefined) _seenKeys.delete(oldest);
    }
    _seenKeys.set(key, { ts: now, count: 1 });
  }
}

function _resetSeenCache() {
  _seenKeys.clear();
}

// ── Public API ───────────────────────────────────────────────────────────

function isEnabled() {
  try {
    return !!_readState().enabled;
  } catch {
    return false;
  }
}

function setEnabled(enabled) {
  _stateCache = _readState();
  _stateCache.enabled = !!enabled;
  _stateCache.updatedAt = new Date().toISOString();
  _writeState({ force: true });
}

function getStatus() {
  const s = _readState();
  return {
    enabled: !!s.enabled,
    updatedAt: s.updatedAt,
    stats: Object.assign({}, s.stats),
    stateFile: _stateFile(),
  };
}

function resetSeenCache() {
  _resetSeenCache();
}

function resetStats() {
  _stateCache = _readState();
  _stateCache.stats = _defaultState().stats;
  _writeState({ force: true });
}

// ── Permission signal hook ──────────────────────────────────────────────
//
// Wired from permissionStore.approve/deny. Mirrors the (user, assistant)
// passive mining of observeTurn but is driven by the user's actual
// allow/always-allow/deny decision — the strongest preference signal khy
// has. Scopes:
//   - 'forever' (总是允许) → high-confidence workflow preference
//   - 'session' / 'once'  → log but don't promote (single-shot decisions
//     are too noisy; the user can change their mind in the next session)
//   - 'deny' any scope    → "用户对此类操作持谨慎态度" (workflow category)

/**
 * End-of-decision hook. Safe to call from any code path; never throws.
 *
 * @param {object} input
 * @param {string} input.toolName
 * @param {'allow'|'deny'} input.decision
 * @param {'once'|'session'|'forever'} [input.scope]
 * @param {string} [input.risk] - 'safe'|'low'|'medium'|'high'|'critical'
 * @returns {{ ok: boolean, observed?: boolean, committed?: number, skipped?: number, error?: string }}
 */
function observePermission(input) {
  const result = { ok: true, observed: false, committed: 0, skipped: 0 };
  try {
    if (!isEnabled()) {
      return result;
    }
    const toolName = (input && typeof input.toolName === 'string') ? input.toolName : '';
    const decision = (input && input.decision) || '';
    if (!toolName || (decision !== 'allow' && decision !== 'deny')) {
      return result;
    }
    const scope = (input && input.scope) || 'once';

    // Map (decision, scope) → (category, text, confidence).
    // Only forever-allow and any-deny get promoted. once/session allow is
    // too noisy to be a taste signal — users hit "yes" on a single risky
    // call without meaning "I always want this to be approved".
    let category = null;
    let text = null;
    let confidence = 0;
    if (decision === 'allow' && scope === 'forever') {
      category = 'workflow';
      text = `用户总是允许 ${toolName} 操作`;
      confidence = 0.8;
    } else if (decision === 'deny') {
      category = 'workflow';
      text = `用户对 ${toolName} 操作持谨慎态度 (deny)`;
      confidence = 0.7;
    } else {
      // once/session allow — log observed but don't promote.
      try {
        _stateCache = _readState();
        _stateCache.stats.observedTurns += 1;
        _writeState();
      } catch { /* best effort */ }
      result.observed = true;
      return result;
    }

    // Per-process dedup (same key + text) so a forever approval that
    // re-fires from a different code path doesn't write twice.
    const k = _dedupKey(category, text);
    if (_isSeenFresh(k)) {
      result.skipped = 1;
      try {
        _stateCache = _readState();
        _stateCache.stats.observedTurns += 1;
        _stateCache.stats.skippedSeen += 1;
        _writeState();
      } catch { /* best effort */ }
      result.observed = true;
      return result;
    }
    _markSeen(k);

    let commitOk = false;
    try {
      const taste = require('./tasteService');
      const out = taste.addPreference({ category, text, confidence });
      if (out && out.ok) {
        result.committed = 1;
        commitOk = true;
      }
    } catch {
      /* single addPreference failure must not abort the rest */
    }

    try {
      _stateCache = _readState();
      _stateCache.stats.observedTurns += 1;
      if (commitOk) _stateCache.stats.committed += 1;
      _writeState();
    } catch { /* best effort */ }

    result.observed = true;
    return result;
  } catch (e) {
    result.ok = false;
    result.error = (e && e.message) || 'observePermission_failed';
    try {
      _stateCache = _readState();
      _stateCache.stats.errors += 1;
      _writeState();
    } catch { /* best effort */ }
    return result;
  }
}

/**
 * End-of-turn hook. Safe to call from any code path; never throws.
 *
 * @param {object} input
 * @param {string} input.userMessage
 * @param {string} input.assistantReply
 * @param {string} [input.sessionId]
 * @param {object} [input.opts]
 * @returns {{ ok: boolean, observed?: boolean, committed?: number, skipped?: number, error?: string }}
 */
function observeTurn(input) {
  const result = {
    ok: true,
    observed: false,
    committed: 0,
    skipped: 0,
  };
  try {
    if (!isEnabled()) {
      return result;
    }
    const userMessage = (input && typeof input.userMessage === 'string') ? input.userMessage : '';
    const assistantReply = (input && typeof input.assistantReply === 'string') ? input.assistantReply : '';
    if (!userMessage && !assistantReply) {
      return result;
    }
    const sessionId = (input && input.sessionId) || 'khyos-cli';

    const learner = require('./crossAgentTasteLearner');
    const rec = {
      type: 'chat',
      message: {
        role: 'user',
        content: userMessage,
      },
    };
    const asstRec = {
      type: 'chat',
      message: {
        role: 'assistant',
        content: assistantReply,
      },
    };

    // Mine user side first (where preferenceSignals + CLI flags + tool
    // prefixes live). Assistant text is intentionally NOT mined — that's
    // the policy in crossAgentTasteLearner.learnFromRecord (see l.249-251).
    let candidates = [];
    try {
      candidates = candidates.concat(learner.learnFromRecord(rec, 'khyos', sessionId));
    } catch {
      /* one record's failure must not poison the other */
    }
    try {
      candidates = candidates.concat(learner.learnFromRecord(asstRec, 'khyos', sessionId));
    } catch {
      /* same */
    }

    if (candidates.length === 0) {
      _stateCache = _readState();
      _stateCache.stats.observedTurns += 1;
      _writeState();
      result.observed = true;
      return result;
    }

    // Per-turn dedup vs. process-local recent memory. crossAgentTasteLearner
    // dedup is per-session; with a stable sessionId the same hit on every
    // turn would not bump confidence but would still re-call addPreference.
    // We pre-filter to keep IO small and avoid re-adding entries that were
    // just written.
    const fresh = [];
    for (const c of candidates) {
      const k = _dedupKey(c.category, c.text);
      if (_isSeenFresh(k)) {
        result.skipped += 1;
        continue;
      }
      _markSeen(k);
      fresh.push(c);
    }

    if (fresh.length === 0) {
      _stateCache = _readState();
      _stateCache.stats.observedTurns += 1;
      _stateCache.stats.skippedSeen += result.skipped;
      _writeState();
      result.observed = true;
      return result;
    }

    const taste = require('./tasteService');
    for (const c of fresh) {
      if (typeof c.confidence !== 'number' || c.confidence < 0.55) {
        continue;
      }
      try {
        const out = taste.addPreference({
          category: c.category,
          text: c.text,
          confidence: c.confidence,
        });
        if (out && out.ok) {
          result.committed += 1;
        }
      } catch {
        /* single addPreference failure must not abort the rest */
      }
    }

    _stateCache = _readState();
    _stateCache.stats.observedTurns += 1;
    _stateCache.stats.committed += result.committed;
    _stateCache.stats.skippedSeen += result.skipped;
    _writeState();

    result.observed = true;
    return result;
  } catch (e) {
    result.ok = false;
    result.error = (e && e.message) || 'observeTurn_failed';
    try {
      _stateCache = _readState();
      _stateCache.stats.errors += 1;
      _writeState();
    } catch {
      /* state write failure is invisible by design */
    }
    return result;
  }
}

module.exports = {
  observeTurn,
  observePermission,
  isEnabled,
  setEnabled,
  getStatus,
  resetSeenCache,
  resetStats,
  // exposed for tests
  _dedupKey,
  _resetSeenCache,
  _stateFile,
};
