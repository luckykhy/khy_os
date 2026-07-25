'use strict';

// Verifies the bounded-retention sweep added to traceAuditService: idle TTL
// eviction, hard LRU cap on sessions, cascade cleanup of trace→session entries,
// and the FIFO safety net on the trace map. Guards against the prior unbounded
// growth of `_sessions` / `_traceToSession`.

describe('traceAuditService bounded retention', () => {
  let originalEnv;
  let auditDir;

  beforeEach(() => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    originalEnv = { ...process.env };
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trace-retention-'));
    process.env.KHY_TRACE_AUDIT_DIR = auditDir;
    process.env.KHY_AUDIT_MAX_SESSIONS = '3';
    process.env.KHY_AUDIT_MAX_TRACE_MAP = '4';
    process.env.KHY_AUDIT_SESSION_TTL_MS = '1000';
    jest.resetModules();
    jest.clearAllMocks();
  });

  afterEach(() => {
    const fs = require('fs');
    process.env = originalEnv;
    if (auditDir) {
      try { fs.rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    jest.resetModules();
    jest.clearAllMocks();
  });

  function emit(traceAudit, n) {
    traceAudit.logEvent('unit.retention', { i: n }, {
      sessionId: `sess-${n}`,
      traceId: `trace-${n}`,
      requestId: `req-${n}`,
      source: 'jest',
    });
  }

  test('TTL sweep evicts idle sessions and their trace mappings', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    emit(traceAudit, 1);
    emit(traceAudit, 2);

    let stats = traceAudit._retentionStats();
    expect(stats.sessions).toBe(2);
    expect(stats.traceMap).toBe(2);

    // Sweep with a clock far past the TTL → both idle sessions evicted.
    const future = Date.now() + 10_000;
    const after = traceAudit._sweepStale(future);
    expect(after.sessions).toBe(0);
    expect(after.traceMap).toBe(0);

    stats = traceAudit._retentionStats();
    expect(stats.sessions).toBe(0);
    expect(stats.traceMap).toBe(0);
  });

  test('LRU cap evicts least-recently-active sessions beyond the hard limit', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    for (let i = 1; i <= 5; i += 1) emit(traceAudit, i);

    // 5 sessions created, cap is 3. Sweep at "now" (not past TTL) keeps the cap.
    const out = traceAudit._sweepStale(Date.now());
    expect(out.sessions).toBe(3);

    const events = traceAudit.getSessionEvents;
    // The three most-recent sessions (3,4,5) survive; oldest (1,2) are gone.
    expect(traceAudit.getSessionMeta('sess-1')).toBeNull();
    expect(traceAudit.getSessionMeta('sess-2')).toBeNull();
    expect(traceAudit.getSessionMeta('sess-5')).not.toBeNull();
    expect(typeof events).toBe('function');
  });

  test('FIFO safety net caps the trace map independent of sessions', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    // Register more trace→session mappings than the cap via attachTrace,
    // without creating _sessions records.
    for (let i = 1; i <= 6; i += 1) {
      traceAudit.attachTrace(`orphan-trace-${i}`, `orphan-sess-${i}`);
    }
    const out = traceAudit._sweepStale(Date.now());
    expect(out.traceMap).toBeLessThanOrEqual(4);
  });

  test('_resetForTest clears both maps and stops the timer', () => {
    const traceAudit = require('../../src/services/traceAuditService');
    emit(traceAudit, 1);
    expect(traceAudit._retentionStats().sessions).toBe(1);
    traceAudit._resetForTest();
    expect(traceAudit._retentionStats().sessions).toBe(0);
    expect(traceAudit._retentionStats().traceMap).toBe(0);
  });
});
