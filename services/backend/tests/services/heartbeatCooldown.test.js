'use strict';

/**
 * Tests for heartbeatCooldown.js — intent-based wake scheduling
 * with flood guard and per-agent tracking.
 */

const {
  shouldDeferWake,
  recordRunStart,
  AgentCooldownTracker,
  DEFAULT_MIN_WAKE_SPACING_MS,
  DEFAULT_FLOOD_WINDOW_MS,
  DEFAULT_FLOOD_THRESHOLD,
} = require('../../src/services/heartbeatCooldown');

describe('shouldDeferWake', () => {
  test('manual intent is never deferred', () => {
    const result = shouldDeferWake({
      intent: 'manual',
      now: 1000,
      nextDueMs: 9999,
      recentRunStarts: [900, 910, 920, 930, 940],
    });
    expect(result.defer).toBe(false);
  });

  test('immediate intent is not deferred normally', () => {
    const result = shouldDeferWake({
      intent: 'immediate',
      now: 1000,
      nextDueMs: 500,
    });
    expect(result.defer).toBe(false);
  });

  test('immediate intent is deferred on flood', () => {
    const now = 1000;
    const result = shouldDeferWake({
      intent: 'immediate',
      now,
      nextDueMs: 500,
      recentRunStarts: [now - 10, now - 20, now - 30, now - 40, now - 50],
      floodThreshold: 5,
      floodWindowMs: 100,
    });
    expect(result.defer).toBe(true);
    expect(result.reason).toBe('flood');
  });

  test('scheduled intent defers when not yet due', () => {
    const result = shouldDeferWake({
      intent: 'scheduled',
      now: 1000,
      nextDueMs: 2000,
    });
    expect(result.defer).toBe(true);
    expect(result.reason).toBe('not-due');
  });

  test('scheduled intent runs when due', () => {
    const result = shouldDeferWake({
      intent: 'scheduled',
      now: 2000,
      nextDueMs: 1000,
    });
    expect(result.defer).toBe(false);
  });

  test('event intent — first wake (no prior run) is not deferred', () => {
    const result = shouldDeferWake({
      intent: 'event',
      now: 1000,
      nextDueMs: 500,
      lastRunStartedAtMs: undefined,
    });
    expect(result.defer).toBe(false);
  });

  test('event intent — defers when not due', () => {
    const result = shouldDeferWake({
      intent: 'event',
      now: 1000,
      nextDueMs: 2000,
      lastRunStartedAtMs: 500,
    });
    expect(result.defer).toBe(true);
    expect(result.reason).toBe('not-due');
  });

  test('event intent — defers on min spacing violation', () => {
    const now = 1000;
    const result = shouldDeferWake({
      intent: 'event',
      now,
      nextDueMs: 500, // is due
      lastRunStartedAtMs: now - 10000, // 10s ago
      minSpacingMs: 30000, // 30s min spacing
    });
    expect(result.defer).toBe(true);
    expect(result.reason).toBe('min-spacing');
  });
});

describe('recordRunStart', () => {
  test('appends timestamp to buffer', () => {
    const buf = [];
    recordRunStart(buf, 1000);
    recordRunStart(buf, 2000);
    expect(buf).toEqual([1000, 2000]);
  });

  test('trims buffer to floodThreshold + 1', () => {
    const buf = [100, 200, 300, 400, 500, 600];
    recordRunStart(buf, 700, 5);
    // max size = floodThreshold + 1 = 6, added 1 = 7, trim to 6
    expect(buf.length).toBeLessThanOrEqual(6);
    expect(buf[buf.length - 1]).toBe(700);
  });
});

describe('AgentCooldownTracker', () => {
  test('registerAgent creates agent state', () => {
    const tracker = new AgentCooldownTracker();
    tracker.registerAgent('agent-1', 60000);
    const state = tracker.getState('agent-1');
    expect(state).not.toBeNull();
    expect(state.intervalMs).toBe(60000);
    expect(state.lastRunStartedAtMs).toBeUndefined();
  });

  test('shouldDefer returns no-defer for unregistered agent', () => {
    const tracker = new AgentCooldownTracker();
    const result = tracker.shouldDefer('unknown', 'manual');
    expect(result.defer).toBe(false);
  });

  test('recordStart updates agent state', () => {
    const tracker = new AgentCooldownTracker();
    tracker.registerAgent('agent-1', 60000);
    tracker.recordStart('agent-1');
    const state = tracker.getState('agent-1');
    expect(state.lastRunStartedAtMs).toBeDefined();
    expect(state.recentRunStarts.length).toBe(1);
  });

  test('getAllStates returns all registered agents', () => {
    const tracker = new AgentCooldownTracker();
    tracker.registerAgent('a');
    tracker.registerAgent('b');
    const states = tracker.getAllStates();
    expect(Object.keys(states)).toContain('a');
    expect(Object.keys(states)).toContain('b');
  });
});

describe('constants', () => {
  test('DEFAULT_MIN_WAKE_SPACING_MS is 30s', () => {
    expect(DEFAULT_MIN_WAKE_SPACING_MS).toBe(30000);
  });

  test('DEFAULT_FLOOD_WINDOW_MS is 60s', () => {
    expect(DEFAULT_FLOOD_WINDOW_MS).toBe(60000);
  });

  test('DEFAULT_FLOOD_THRESHOLD is 5', () => {
    expect(DEFAULT_FLOOD_THRESHOLD).toBe(5);
  });
});
