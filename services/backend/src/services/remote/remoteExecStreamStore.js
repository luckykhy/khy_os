'use strict';

const crypto = require('crypto');

const DEFAULT_COMPLETED_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RUNNING_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_STREAMS = 240;
const DEFAULT_MAX_EVENTS_PER_STREAM = 600;

function _readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function _streamNowIso() {
  return new Date().toISOString();
}

function _streamNowMs() {
  return Date.now();
}

function _normalizeAfterSeq(afterSeq) {
  const parsed = Number.parseInt(afterSeq, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function buildRemoteExecStreamRequestFingerprint({
  connectionId,
  commands,
  dryRun,
  idempotencyKey,
  approvalTicketId,
  riskContext,
}) {
  const hash = crypto.createHash('sha256');
  hash.update(String(connectionId || ''));
  hash.update('\n');
  hash.update(JSON.stringify(Array.isArray(commands) ? commands : []));
  hash.update('\n');
  hash.update(dryRun ? '1' : '0');
  hash.update('\n');
  hash.update(String(idempotencyKey || ''));
  hash.update('\n');
  hash.update(String(approvalTicketId || ''));
  hash.update('\n');
  try {
    hash.update(JSON.stringify(riskContext || null));
  } catch {
    hash.update('[risk_context_unserializable]');
  }
  return hash.digest('hex');
}

class RemoteExecStreamStore {
  constructor(options = {}) {
    this._sessions = new Map();
    this._onMutate = typeof options.onMutate === 'function' ? options.onMutate : null;
    this._completedTtlMs = _readPositiveInt(
      process.env.KHY_REMOTE_SSH_STREAM_TTL_MS,
      DEFAULT_COMPLETED_TTL_MS
    );
    this._runningTtlMs = _readPositiveInt(
      process.env.KHY_REMOTE_SSH_RUNNING_STREAM_TTL_MS,
      DEFAULT_RUNNING_TTL_MS
    );
    this._maxStreams = _readPositiveInt(
      process.env.KHY_REMOTE_SSH_MAX_STREAMS,
      DEFAULT_MAX_STREAMS
    );
    this._maxEventsPerStream = _readPositiveInt(
      process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS,
      DEFAULT_MAX_EVENTS_PER_STREAM
    );
  }

  _notifyMutation(reason, payload = {}) {
    if (typeof this._onMutate !== 'function') return;
    try {
      this._onMutate({
        source: 'remote_exec_stream_store',
        reason,
        payload,
      });
    } catch {
      /* ignore persistence callback failures */
    }
  }

  _cleanupExpiredSessions() {
    const nowMs = _streamNowMs();
    const toDelete = [];
    for (const [streamId, session] of this._sessions.entries()) {
      const ageSinceUpdate = nowMs - session.lastActivityMs;
      if (session.done && ageSinceUpdate > this._completedTtlMs) {
        toDelete.push(streamId);
        continue;
      }
      if (!session.done && ageSinceUpdate > this._runningTtlMs) {
        toDelete.push(streamId);
      }
    }
    for (const streamId of toDelete) {
      this._sessions.delete(streamId);
    }
  }

  _enforceStreamCap() {
    if (this._sessions.size <= this._maxStreams) return;

    const completed = [];
    const running = [];
    for (const [streamId, session] of this._sessions.entries()) {
      const bucket = session.done ? completed : running;
      bucket.push({ streamId, updatedAtMs: session.lastActivityMs });
    }

    completed.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    running.sort((a, b) => a.updatedAtMs - b.updatedAtMs);

    const ordered = completed.concat(running);
    const overflow = this._sessions.size - this._maxStreams;
    for (let i = 0; i < overflow && i < ordered.length; i++) {
      this._sessions.delete(ordered[i].streamId);
    }
  }

  _cloneSession(session) {
    if (!session) return null;
    return {
      stream_id: session.streamId,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      done: session.done,
      started: session.started,
      terminal_status: session.terminalStatus,
      last_seq: session.lastSeq,
      request_fingerprint: session.requestFingerprint || null,
      request_context: session.requestContext ? { ...session.requestContext } : null,
      metadata: session.metadata ? { ...session.metadata } : {},
    };
  }

  _cloneRecord(record) {
    return {
      seq: record.seq,
      event: record.event,
      data: record.data && typeof record.data === 'object'
        ? { ...record.data }
        : record.data,
      ts: record.ts,
    };
  }

  _buildSession({
    streamId,
    requestFingerprint,
    requestContext,
    metadata,
  }) {
    const nowIso = _streamNowIso();
    const nowMs = _streamNowMs();
    return {
      streamId,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdAtMs: nowMs,
      lastActivityMs: nowMs,
      started: false,
      done: false,
      terminalStatus: 'running',
      requestFingerprint: requestFingerprint || null,
      requestContext: requestContext && typeof requestContext === 'object'
        ? { ...requestContext }
        : null,
      metadata: metadata && typeof metadata === 'object'
        ? { ...metadata }
        : {},
      events: [],
      lastSeq: 0,
      subscribers: new Set(),
      executionPromise: null,
    };
  }

  _touchSession(session) {
    session.lastActivityMs = _streamNowMs();
    session.updatedAt = _streamNowIso();
  }

  hasSession(streamId) {
    this._cleanupExpiredSessions();
    return this._sessions.has(String(streamId || '').trim());
  }

  getSession(streamId) {
    this._cleanupExpiredSessions();
    return this._cloneSession(this._sessions.get(String(streamId || '').trim()));
  }

  ensureSession({ streamId, requestFingerprint = null, requestContext = null, metadata = null }) {
    this._cleanupExpiredSessions();
    const key = String(streamId || '').trim();
    if (!key) {
      return {
        ok: false,
        code: 'stream_id_required',
        message: 'stream_id is required.',
      };
    }

    const existing = this._sessions.get(key);
    if (existing) {
      if (
        requestFingerprint
        && existing.requestFingerprint
        && existing.requestFingerprint !== requestFingerprint
      ) {
        return {
          ok: false,
          code: 'stream_payload_conflict',
          message: 'stream_id already exists with a different execution payload.',
          session: this._cloneSession(existing),
        };
      }

      if (requestFingerprint && !existing.requestFingerprint) {
        existing.requestFingerprint = requestFingerprint;
      }
      if (requestContext && typeof requestContext === 'object') {
        existing.requestContext = {
          ...(existing.requestContext || {}),
          ...requestContext,
        };
      }
      if (metadata && typeof metadata === 'object') {
        existing.metadata = {
          ...(existing.metadata || {}),
          ...metadata,
        };
      }
      this._touchSession(existing);
      this._notifyMutation('update_session', { stream_id: key });
      return {
        ok: true,
        created: false,
        session: this._cloneSession(existing),
      };
    }

    const session = this._buildSession({
      streamId: key,
      requestFingerprint,
      requestContext,
      metadata,
    });
    this._sessions.set(key, session);
    this._enforceStreamCap();
    this._notifyMutation('create_session', { stream_id: key });
    return {
      ok: true,
      created: true,
      session: this._cloneSession(session),
    };
  }

  claimStart(streamId) {
    this._cleanupExpiredSessions();
    const key = String(streamId || '').trim();
    if (!key) {
      return {
        ok: false,
        code: 'stream_id_required',
      };
    }
    const session = this._sessions.get(key);
    if (!session) {
      return {
        ok: false,
        code: 'stream_not_found',
      };
    }
    if (session.started) {
      return {
        ok: true,
        shouldStart: false,
      };
    }
    session.started = true;
    this._touchSession(session);
    this._notifyMutation('start_session', { stream_id: key });
    return {
      ok: true,
      shouldStart: true,
    };
  }

  setExecutionPromise(streamId, promise) {
    const key = String(streamId || '').trim();
    const session = this._sessions.get(key);
    if (!session) return false;
    session.executionPromise = promise || null;
    this._touchSession(session);
    return true;
  }

  getExecutionPromise(streamId) {
    const key = String(streamId || '').trim();
    const session = this._sessions.get(key);
    return session ? session.executionPromise : null;
  }

  appendEvent(streamId, { event, data }) {
    this._cleanupExpiredSessions();
    const key = String(streamId || '').trim();
    const session = this._sessions.get(key);
    if (!session) return null;

    session.lastSeq += 1;
    this._touchSession(session);

    const record = {
      seq: session.lastSeq,
      event: String(event || 'message'),
      data: data && typeof data === 'object' ? { ...data } : (data ?? null),
      ts: _streamNowIso(),
    };
    session.events.push(record);

    if (session.events.length > this._maxEventsPerStream) {
      session.events = session.events.slice(session.events.length - this._maxEventsPerStream);
    }

    if (record.event === 'done') {
      session.done = true;
      session.terminalStatus = (
        record.data
        && typeof record.data === 'object'
        && record.data.status
      )
        ? String(record.data.status)
        : 'completed';
    }

    this._notifyMutation('append_event', {
      stream_id: key,
      seq: record.seq,
      event: record.event,
      done: session.done,
    });

    const subscribers = Array.from(session.subscribers);
    for (const listener of subscribers) {
      try {
        listener(this._cloneRecord(record), this._cloneSession(session));
      } catch {
        /* ignore subscriber callback errors */
      }
    }

    return this._cloneRecord(record);
  }

  getEventsSince(streamId, afterSeq = 0) {
    this._cleanupExpiredSessions();
    const key = String(streamId || '').trim();
    const session = this._sessions.get(key);
    if (!session) return null;

    const normalizedAfterSeq = _normalizeAfterSeq(afterSeq);
    const firstAvailableSeq = session.events.length > 0
      ? session.events[0].seq
      : session.lastSeq + 1;

    const truncated = normalizedAfterSeq < (firstAvailableSeq - 1);
    const events = session.events
      .filter((record) => record.seq > normalizedAfterSeq)
      .map((record) => this._cloneRecord(record));

    return {
      stream_id: key,
      after_seq: normalizedAfterSeq,
      first_available_seq: firstAvailableSeq,
      last_seq: session.lastSeq,
      done: session.done,
      terminal_status: session.terminalStatus,
      truncated,
      events,
    };
  }

  subscribe(streamId, listener) {
    this._cleanupExpiredSessions();
    const key = String(streamId || '').trim();
    const session = this._sessions.get(key);
    if (!session || typeof listener !== 'function') {
      return () => {};
    }
    session.subscribers.add(listener);
    return () => {
      const current = this._sessions.get(key);
      if (!current) return;
      current.subscribers.delete(listener);
    };
  }

  isDone(streamId) {
    this._cleanupExpiredSessions();
    const key = String(streamId || '').trim();
    const session = this._sessions.get(key);
    return Boolean(session && session.done);
  }

  exportState() {
    this._cleanupExpiredSessions();
    return Array.from(this._sessions.values()).map((session) => ({
      stream_id: session.streamId,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      created_at_ms: session.createdAtMs,
      last_activity_ms: session.lastActivityMs,
      started: session.started,
      done: session.done,
      terminal_status: session.terminalStatus,
      request_fingerprint: session.requestFingerprint || null,
      request_context: session.requestContext ? { ...session.requestContext } : null,
      metadata: session.metadata ? { ...session.metadata } : {},
      last_seq: session.lastSeq,
      events: session.events.map((record) => ({
        seq: record.seq,
        event: record.event,
        data: record.data && typeof record.data === 'object' ? { ...record.data } : record.data,
        ts: record.ts,
      })),
    }));
  }

  importState(sessions = []) {
    this._sessions.clear();
    const nowMs = _streamNowMs();
    const list = Array.isArray(sessions) ? sessions : [];
    for (const rawSession of list) {
      if (!rawSession || typeof rawSession !== 'object') continue;
      const streamId = String(rawSession.stream_id || '').trim();
      if (!streamId) continue;

      const events = Array.isArray(rawSession.events)
        ? rawSession.events
            .map((record) => {
              const seq = Number.parseInt(record?.seq, 10);
              if (!Number.isFinite(seq) || seq <= 0) return null;
              return {
                seq,
                event: String(record?.event || 'message'),
                data: record?.data && typeof record.data === 'object'
                  ? { ...record.data }
                  : (record?.data ?? null),
                ts: record?.ts || new Date().toISOString(),
              };
            })
            .filter(Boolean)
            .sort((a, b) => a.seq - b.seq)
        : [];

      const createdAt = rawSession.created_at || new Date().toISOString();
      const updatedAt = rawSession.updated_at || createdAt;
      const createdAtMsRaw = Number.parseInt(rawSession.created_at_ms, 10);
      const parsedCreatedAtMs = Number.isFinite(createdAtMsRaw) ? createdAtMsRaw : Date.parse(createdAt);
      const createdAtMs = Number.isFinite(parsedCreatedAtMs) ? parsedCreatedAtMs : nowMs;
      const lastActivityMsRaw = Number.parseInt(rawSession.last_activity_ms, 10);
      const parsedLastActivityMs = Number.isFinite(lastActivityMsRaw) ? lastActivityMsRaw : Date.parse(updatedAt);
      const lastActivityMs = Number.isFinite(parsedLastActivityMs) ? parsedLastActivityMs : nowMs;
      const done = Boolean(rawSession.done);
      const lastSeqFromState = Number.parseInt(rawSession.last_seq, 10);
      const lastSeqFromEvents = events.length > 0 ? events[events.length - 1].seq : 0;
      const lastSeq = Number.isFinite(lastSeqFromState) && lastSeqFromState > 0
        ? Math.max(lastSeqFromState, lastSeqFromEvents)
        : lastSeqFromEvents;

      this._sessions.set(streamId, {
        streamId,
        createdAt,
        updatedAt,
        createdAtMs,
        lastActivityMs,
        started: Boolean(rawSession.started),
        done,
        terminalStatus: String(rawSession.terminal_status || (done ? 'completed' : 'running')),
        requestFingerprint: rawSession.request_fingerprint || null,
        requestContext: rawSession.request_context && typeof rawSession.request_context === 'object'
          ? { ...rawSession.request_context }
          : null,
        metadata: rawSession.metadata && typeof rawSession.metadata === 'object'
          ? { ...rawSession.metadata }
          : {},
        events,
        lastSeq,
        subscribers: new Set(),
        executionPromise: null,
      });
    }

    this._cleanupExpiredSessions();
    this._enforceStreamCap();
    this._notifyMutation('import_state', { total: this._sessions.size });
    return this._sessions.size;
  }

  clearAll() {
    this._sessions.clear();
    this._notifyMutation('clear_all');
  }
}

module.exports = {
  RemoteExecStreamStore,
  createRemoteExecStreamStore: (options = {}) => new RemoteExecStreamStore(options),
  buildRemoteExecStreamRequestFingerprint,
};
