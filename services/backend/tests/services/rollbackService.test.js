'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-rollback-'));
process.env.KHY_DATA_HOME = TMP;

const rollback = require('../../src/services/rollbackService');

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('rollbackService — four-level facade', () => {
  test('patch: snapshot → edit → undo restores prior content', () => {
    const f = path.join(TMP, 'sample.txt');
    fs.writeFileSync(f, 'v1');
    const s1 = rollback.snapshot({ granularity: 'patch', filePath: f });
    expect(s1.success).toBe(true);
    expect(s1.granularity).toBe('patch');
    expect(s1.slaMs).toBe(100);

    fs.writeFileSync(f, 'v2');
    rollback.snapshot({ granularity: 'patch', filePath: f });

    const u = rollback.undo({ filePath: f });
    expect(u.success).toBe(true);
    expect(u.restored).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('v1');
  });

  test('patch: rewindTo a specific snapshot index', () => {
    const f = path.join(TMP, 'multi.txt');
    fs.writeFileSync(f, 'A');
    rollback.snapshot({ granularity: 'patch', filePath: f }); // idx 0 = "A"
    fs.writeFileSync(f, 'B');
    rollback.snapshot({ granularity: 'patch', filePath: f }); // idx 1 = "B"
    fs.writeFileSync(f, 'C');

    const r = rollback.rollback({ granularity: 'patch', filePath: f, snapshotIndex: 0 });
    expect(r.success).toBe(true);
    expect(fs.readFileSync(f, 'utf8')).toBe('A');
  });

  test('turn: snapshot is data-only and rollback returns it without in-place restore', () => {
    const snap = rollback.snapshot({
      granularity: 'turn', sessionId: 'sess-T',
      ctx: { messages: [{ role: 'user', content: 'hi' }], toolCallLog: [], goal: 'do X' },
    });
    expect(snap.success).toBe(true);
    expect(snap.slaMs).toBe(500);

    const r = rollback.rollback({ granularity: 'turn', sessionId: 'sess-T' });
    expect(r.success).toBe(true);
    expect(r.restored).toBe(false);     // canonicalState has no in-place restore
    expect(r.snapshot).toBeTruthy();
    expect(r.note).toMatch(/re-inject/);
  });

  test('turn: rollback with no snapshot fails cleanly', () => {
    const r = rollback.rollback({ granularity: 'turn', sessionId: 'never-existed' });
    expect(r.success).toBe(false);
  });

  test('invalid inputs degrade to structured errors, never throw', () => {
    expect(rollback.snapshot({ granularity: 'bogus' }).success).toBe(false);
    expect(rollback.snapshot({ granularity: 'patch' }).error).toMatch(/filePath/);
    expect(rollback.rollback({ granularity: 'session' }).error).toMatch(/projectDir/);
    expect(rollback.undo({ filePath: '/no/such/file/xyz' }).success).toBeDefined();
  });

  test('SLA targets follow blast radius ordering', () => {
    expect(rollback.SLA_MS.patch).toBeLessThan(rollback.SLA_MS.turn);
    expect(rollback.SLA_MS.turn).toBeLessThan(rollback.SLA_MS.session);
    expect(rollback.SLA_MS.version).toBe(Infinity);
  });
});
