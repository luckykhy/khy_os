'use strict';

/**
 * heartbeatCooldown.js — Intent-based wake scheduling with flood guard.
 *
 * Ported from OpenClaw's heartbeat-cooldown.ts.
 * Prevents runaway agent scheduling through:
 *   - Intent-based decision matrix (manual→immediate→scheduled→event)
 *   - Minimum spacing floor (30s default)
 *   - Flood guard (5 wakes in 60s triggers defer)
 *   - Per-agent cooldown tracking with bounded buffer
 *
 * Decision Matrix:
 *   | Intent     | First wake      | Subsequent wakes              |
 *   |------------|-----------------|-------------------------------|
 *   | manual     | Run             | Run (never deferred)          |
 *   | immediate  | Run             | Run (except flood)            |
 *   | scheduled  | Defer if !due   | Defer if !due                 |
 *   | event      | Run (bootstrap) | Defer if !due OR within floor |
 */

const DEFAULT_MIN_WAKE_SPACING_MS = 30_000;   // 30 seconds
const DEFAULT_FLOOD_WINDOW_MS = 60_000;        // 60 seconds
const DEFAULT_FLOOD_THRESHOLD = 5;             // 5 wakes in flood window

/**
 * @typedef {object} ShouldDeferInput
 * @property {'manual'|'immediate'|'scheduled'|'event'} intent
 * @property {string} [source]
 * @property {string} [reason]
 * @property {number} now - Current timestamp (Date.now())
 * @property {number} nextDueMs - When next scheduled run is due
 * @property {number} [lastRunStartedAtMs] - When agent last started
 * @property {number[]} [recentRunStarts] - Recent wake timestamps
 * @property {number} [minSpacingMs]
 * @property {number} [floodWindowMs]
 * @property {number} [floodThreshold]
 */

/**
 * @typedef {object} DeferDecision
 * @property {boolean} defer
 * @property {'not-due'|'min-spacing'|'flood'} [reason]
 */

/**
 * Determine whether a wake should be deferred.
 *
 * @param {ShouldDeferInput} input
 * @returns {DeferDecision}
 */
function shouldDeferWake(input) {
  // Manual: never deferred
  if (input.intent === 'manual') {
    return { defer: false };
  }

  // Immediate: only deferred on flood
  if (input.intent === 'immediate') {
    const floodDefer = _checkFloodGuard(input);
    return floodDefer || { defer: false };
  }

  // Check flood guard for scheduled/event intents
  const floodDefer = _checkFloodGuard(input);
  if (floodDefer) {
    return floodDefer;
  }

  // Scheduled: defer if not yet due
  if (input.intent === 'scheduled') {
    return input.now < input.nextDueMs
      ? { defer: true, reason: 'not-due' }
      : { defer: false };
  }

  // Event: first wake (no prior run) bypasses cooldown gates
  if (input.lastRunStartedAtMs === undefined) {
    return { defer: false };
  }

  // Event: check if due
  if (input.now < input.nextDueMs) {
    return { defer: true, reason: 'not-due' };
  }

  // Event: enforce min spacing floor
  const minSpacing = input.minSpacingMs ?? DEFAULT_MIN_WAKE_SPACING_MS;
  if (minSpacing > 0 && input.now - input.lastRunStartedAtMs < minSpacing) {
    return { defer: true, reason: 'min-spacing' };
  }

  return { defer: false };
}

/**
 * Check flood guard: too many wakes in a short window.
 *
 * @param {ShouldDeferInput} input
 * @returns {DeferDecision|null} - null if no flood detected
 */
function _checkFloodGuard(input) {
  const floodWindow = input.floodWindowMs ?? DEFAULT_FLOOD_WINDOW_MS;
  const floodThreshold = input.floodThreshold ?? DEFAULT_FLOOD_THRESHOLD;

  if (!input.recentRunStarts
      || input.recentRunStarts.length < floodThreshold
      || floodWindow <= 0) {
    return null;
  }

  const windowStart = input.now - floodWindow;
  let inWindow = 0;

  // Scan from most recent backward
  for (let i = input.recentRunStarts.length - 1; i >= 0; i--) {
    const ts = input.recentRunStarts[i];
    if (ts === undefined || ts < windowStart) break;
    inWindow++;
  }

  return inWindow >= floodThreshold
    ? { defer: true, reason: 'flood' }
    : null;
}

/**
 * Record a run start timestamp in the bounded buffer.
 *
 * @param {number[]} buffer - Mutable array of timestamps
 * @param {number} ts - Current timestamp
 * @param {number} [floodThreshold=5] - Controls buffer max size
 * @returns {number[]} The mutated buffer
 */
function recordRunStart(buffer, ts, floodThreshold = DEFAULT_FLOOD_THRESHOLD) {
  buffer.push(ts);
  const max = floodThreshold + 1;
  while (buffer.length > max) {
    buffer.shift();
  }
  return buffer;
}

/**
 * Per-agent cooldown tracker.
 * Manages scheduling state for multiple agents.
 */
class AgentCooldownTracker {
  constructor(opts = {}) {
    this._agents = new Map(); // agentId → { lastRunStartedAtMs, nextDueMs, recentRunStarts }
    this._defaultInterval = opts.defaultIntervalMs || 300_000; // 5 min default
  }

  /**
   * Register or update an agent's scheduling state.
   */
  registerAgent(agentId, intervalMs) {
    if (!this._agents.has(agentId)) {
      this._agents.set(agentId, {
        lastRunStartedAtMs: undefined,
        nextDueMs: Date.now(),
        recentRunStarts: [],
        intervalMs: intervalMs || this._defaultInterval,
      });
    } else if (intervalMs) {
      this._agents.get(agentId).intervalMs = intervalMs;
    }
  }

  /**
   * Check if an agent wake should be deferred.
   *
   * @param {string} agentId
   * @param {'manual'|'immediate'|'scheduled'|'event'} intent
   * @returns {DeferDecision}
   */
  shouldDefer(agentId, intent) {
    const state = this._agents.get(agentId);
    if (!state) return { defer: false };

    return shouldDeferWake({
      intent,
      now: Date.now(),
      nextDueMs: state.nextDueMs,
      lastRunStartedAtMs: state.lastRunStartedAtMs,
      recentRunStarts: state.recentRunStarts,
    });
  }

  /**
   * Record that an agent started running.
   */
  recordStart(agentId) {
    const state = this._agents.get(agentId);
    if (!state) return;

    const now = Date.now();
    state.lastRunStartedAtMs = now;
    recordRunStart(state.recentRunStarts, now);
    state.nextDueMs = now + state.intervalMs;
  }

  /**
   * Get agent scheduling state (for diagnostics).
   */
  getState(agentId) {
    return this._agents.get(agentId) || null;
  }

  /**
   * Get all agent states.
   */
  getAllStates() {
    const result = {};
    for (const [id, state] of this._agents) {
      result[id] = { ...state };
    }
    return result;
  }
}

module.exports = {
  shouldDeferWake,
  recordRunStart,
  AgentCooldownTracker,
  DEFAULT_MIN_WAKE_SPACING_MS,
  DEFAULT_FLOOD_WINDOW_MS,
  DEFAULT_FLOOD_THRESHOLD,
};
