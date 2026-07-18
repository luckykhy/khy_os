'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the stats ledger into a throwaway data home before requiring the
// service (dataHome caches KHY_DATA_HOME on first use).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-agentstats-'));
process.env.KHY_DATA_HOME = TMP;

const stats = require('../../src/services/agentStatsService');

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('agentStatsService — load ledger (B3)', () => {
  test('incActive / decActive track a sliding load counter that floors at zero', () => {
    expect(stats.incActive('claude')).toBe(1);
    expect(stats.incActive('claude')).toBe(2);
    expect(stats.getStats('claude').activeCount).toBe(2);
    expect(stats.decActive('claude')).toBe(1);
    // Over-decrementing must not drive the count negative.
    stats.decActive('claude');
    expect(stats.decActive('claude')).toBe(0);
    expect(stats.getStats('claude').activeCount).toBe(0);
  });

  test('recordResult computes reworkRate = reworked / completed', () => {
    stats.recordResult('codex', { reworked: false });
    expect(stats.getStats('codex').reworkRate).toBe(0);
    stats.recordResult('codex', { reworked: true });
    expect(stats.getStats('codex').reworkRate).toBe(0.5);
    stats.recordResult('codex', { reworked: false });
    stats.recordResult('codex', { reworked: false });
    // 1 reworked / 4 completed
    expect(stats.getStats('codex').reworkRate).toBeCloseTo(0.25, 5);
  });

  test('getStats returns zeroed defaults for an unknown type (never null)', () => {
    const s = stats.getStats('never-seen');
    expect(s).toEqual({ completed: 0, reworked: 0, reworkRate: 0, activeCount: 0, lastUpdatedAt: null });
  });

  test('persists across a fresh module load (survives process restart)', () => {
    stats.incActive('kiro');
    stats.recordResult('kiro', { reworked: true });
    jest.resetModules();
    const reloaded = require('../../src/services/agentStatsService');
    const s = reloaded.getStats('kiro');
    expect(s.activeCount).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.reworked).toBe(1);
  });

  test('resetActiveCounts clears leaked load without touching completion stats', () => {
    const fresh = require('../../src/services/agentStatsService');
    fresh.incActive('warp');
    fresh.recordResult('warp', { reworked: false });
    fresh.resetActiveCounts();
    const s = fresh.getStats('warp');
    expect(s.activeCount).toBe(0);
    expect(s.completed).toBe(1);
  });

  test('ignores empty/falsy type names without throwing', () => {
    expect(stats.incActive('')).toBe(0);
    expect(stats.decActive(null)).toBe(0);
    expect(stats.recordResult(undefined, { reworked: true })).toBe(0);
  });
});
