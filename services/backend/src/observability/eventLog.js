'use strict';

/**
 * eventLog.js — append-only event log (JSONL) with in-process fan-out.
 *
 * The observable/recoverable foundation for /dream daemon checkpoints,
 * coordinator observability, and the cost meter. Every event is:
 *   1. normalized to a stable shape,
 *   2. published to the in-process eventBus synchronously (real-time), and
 *   3. appended to a JSONL shard under getDataDir('events/') (durable/replayable).
 *
 * Reuses the JSONL + fail-soft style of telemetryService.recordAuditEvent() and
 * sessionPersistence: writes are best-effort — a write failure only warns, it
 * never throws and never blocks the caller's main flow.
 *
 * Configuration is intentionally minimal (a few env vars + sane defaults):
 *   - KHY_EVENTLOG_ENABLED  (default on)  — {0,false,off,no} disables disk writes
 *                                           (bus fan-out still happens).
 *   - KHY_EVENTLOG_SHARD    (default date) — 'date' → events-YYYY-MM-DD.jsonl,
 *                                           'trace' → trace-<traceId>.jsonl.
 *   - KHY_EVENTLOG_DIR      (optional)    — override the events directory.
 *
 * Event shape (as persisted and published):
 *   { ts, seq, type, source, traceId, payload }
 */
const fs = require('fs');
const path = require('path');

const eventBus = require('./eventBus');

// Monotonic per-process sequence — stable ordering when timestamps collide.
let _seq = 0;
let _warned = false;

function _flag(raw, defaultOn = true) {
  if (raw == null) {
    return defaultOn;
  }
  const v = String(raw).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') {
    return false;
  }
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') {
    return true;
  }
  return defaultOn;
}

function _enabled() {
  return _flag(process.env.KHY_EVENTLOG_ENABLED, true);
}

function _shardMode() {
  const v = String(process.env.KHY_EVENTLOG_SHARD || 'date')
    .trim()
    .toLowerCase();
  return v === 'trace' ? 'trace' : 'date';
}

/** Resolve (and create) the events directory. Fail-soft. */
function _eventsDir() {
  if (process.env.KHY_EVENTLOG_DIR) {
    const dir = path.resolve(process.env.KHY_EVENTLOG_DIR);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    return dir;
  }
  // getDataDir() creates the directory and is portable/system-drive-safe.
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('events');
}

function _sanitize(s) {
  return (
    String(s == null ? '' : s)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'unknown'
  );
}

/** Pick the shard file for an entry (date-based by default, trace-based opt-in). */
function _shardFile(dir, entry) {
  if (_shardMode() === 'trace' && entry.traceId) {
    return path.join(dir, `trace-${_sanitize(entry.traceId)}.jsonl`);
  }
  const day = (typeof entry.ts === 'string' ? entry.ts : new Date().toISOString()).slice(0, 10);
  return path.join(dir, `events-${day}.jsonl`);
}

function _toMs(ts) {
  if (ts == null) {
    return NaN;
  }
  if (typeof ts === 'number') {
    return ts;
  }
  const t = Date.parse(ts);
  return Number.isNaN(t) ? NaN : t;
}

function _warnOnce(err) {
  if (_warned) {
    return;
  }
  _warned = true;
  try {
    console.warn(
      '[eventLog] append failed (fail-soft; further warnings suppressed):',
      err && err.message ? err.message : err
    );
  } catch {
    /* ignore */
  }
}

function _normalize(event) {
  const ev = event || {};
  let ts;
  if (typeof ev.ts === 'string') {
    ts = ev.ts;
  } else if (Number.isFinite(ev.ts)) {
    ts = new Date(ev.ts).toISOString();
  } else {
    ts = new Date().toISOString();
  }

  return {
    ts,
    seq: ++_seq,
    type: String(ev.type || 'unknown'),
    source: ev.source != null ? String(ev.source) : 'unknown',
    traceId: ev.traceId != null ? String(ev.traceId) : null,
    payload: ev.payload !== undefined ? ev.payload : {},
  };
}

/**
 * Append an event. ALWAYS fail-soft — never throws, never blocks the caller.
 *
 * The bus fan-out happens first (and unconditionally, even if disk writes are
 * disabled) so real-time subscribers never depend on disk state.
 *
 * @param {object} event
 * @param {string} event.type    - dotted event type, e.g. 'task.created'
 * @param {string} [event.source]- producer id, e.g. 'taskBoard'
 * @param {*}      [event.payload]- arbitrary JSON-serializable data
 * @param {string} [event.traceId]- correlation id (task id, session id, agent id…)
 * @param {string|number} [event.ts]- ISO string or epoch ms (defaults to now)
 * @returns {object} the normalized entry that was published/persisted.
 */
function append(event = {}) {
  const entry = _normalize(event);

  // 1. Real-time fan-out (synchronous, fail-soft inside publish()).
  eventBus.publish(entry);

  // 2. Durable append-only persistence (best-effort).
  if (_enabled()) {
    try {
      const dir = _eventsDir();
      const file = _shardFile(dir, entry);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      _warnOnce(err);
    }
  }

  return entry;
}

function _sorted(list) {
  return list.sort((a, b) => {
    const ta = _toMs(a.ts);
    const tb = _toMs(b.ts);
    if (ta !== tb) {
      return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
    }
    return (a.seq || 0) - (b.seq || 0);
  });
}

/**
 * Read events from disk with optional filtering. Fail-soft: returns [] on any error.
 *
 * @param {object} [filter]
 * @param {string} [filter.traceId] - only events with this traceId
 * @param {string} [filter.type]    - only events of this type
 * @param {string} [filter.source]  - only events from this source
 * @param {string|number} [filter.since] - ISO/epoch lower bound (inclusive)
 * @param {string|number} [filter.until] - ISO/epoch upper bound (inclusive)
 * @param {number} [filter.limit]   - cap number of returned events
 * @returns {object[]} events sorted by (ts, seq) ascending.
 */
function read(filter = {}) {
  const results = [];
  let dir;
  let files;
  try {
    dir = _eventsDir();
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return results;
  }

  // Fast path: trace-sharded file exists for the requested traceId.
  if (filter.traceId) {
    const tf = `trace-${_sanitize(filter.traceId)}.jsonl`;
    if (files.includes(tf)) {
      files = [tf];
    }
  }
  files.sort();

  const sinceMs = filter.since != null ? _toMs(filter.since) : null;
  const untilMs = filter.until != null ? _toMs(filter.until) : null;
  const limit = Number.isFinite(filter.limit) ? filter.limit : Infinity;

  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(dir, f), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (filter.traceId != null && entry.traceId !== String(filter.traceId)) {
        continue;
      }
      if (filter.type != null && entry.type !== String(filter.type)) {
        continue;
      }
      if (filter.source != null && entry.source !== String(filter.source)) {
        continue;
      }
      if (sinceMs != null || untilMs != null) {
        const t = _toMs(entry.ts);
        if (sinceMs != null && !(t >= sinceMs)) {
          continue;
        }
        if (untilMs != null && !(t <= untilMs)) {
          continue;
        }
      }
      results.push(entry);
    }
  }

  const sorted = _sorted(results);
  return Number.isFinite(limit) && sorted.length > limit ? sorted.slice(0, limit) : sorted;
}

/**
 * Replay events (by traceId and/or time range), optionally invoking a callback
 * per event in chronological order. Returns the ordered event array either way.
 * Fail-soft: a throwing callback never aborts the replay.
 *
 * @param {object} [filter] - same shape as read()
 * @param {(event: object) => void} [onEvent] - optional per-event visitor
 * @returns {object[]} ordered events
 */
function replay(filter = {}, onEvent) {
  const events = read(filter);
  if (typeof onEvent === 'function') {
    for (const e of events) {
      try {
        onEvent(e);
      } catch {
        /* fail-soft */
      }
    }
  }
  return events;
}

/**
 * Append a snapshot event capturing full task/runtime state for later
 * replay/recovery. Fail-soft.
 *
 * @param {string} taskId
 * @param {*} fullState - JSON-serializable state blob
 * @param {object} [opts]
 * @param {string} [opts.source='snapshot']
 * @param {string} [opts.traceId] - defaults to taskId
 * @returns {object} the persisted snapshot entry.
 */
function snapshot(taskId, fullState, opts = {}) {
  return append({
    type: 'snapshot',
    source: opts.source || 'snapshot',
    traceId: opts.traceId != null ? opts.traceId : taskId != null ? String(taskId) : null,
    payload: { taskId: taskId != null ? String(taskId) : null, state: fullState },
  });
}

/** Resolve the current events directory (created). Exposed for tooling/tests. */
function getEventsDir() {
  return _eventsDir();
}

module.exports = {
  append,
  read,
  replay,
  snapshot,
  getEventsDir,
  // re-export bus helpers so consumers can require a single module
  bus: eventBus.bus,
  CHANNEL: eventBus.CHANNEL,
  subscribe: eventBus.subscribe,
  subscribeAll: eventBus.subscribeAll,
  publish: eventBus.publish,
};
