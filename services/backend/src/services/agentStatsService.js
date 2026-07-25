'use strict';

/**
 * agentStatsService.js — Per-agent-type lightweight performance ledger (B3).
 *
 * Purpose: capability-weighted sub-agent selection needs two runtime signals
 * that no existing store provides:
 *   1. rework rate — how often this agent type's work had to be redone
 *      (a failed or retried subtask is "reworked"); lower is better.
 *   2. current load — how many subtasks of this type are running *right now*;
 *      a sliding inc/dec counter (NOT a fixed timeout), decremented on every
 *      exit path (success, failure, exception) so it never leaks.
 *
 * These feed `capabilityRegistry.bestAdaptersFor` as gentle weight terms so a
 * historically-reliable, currently-idle agent is preferred over a flaky or
 * saturated one — without overturning the underlying capability ranking.
 *
 * Persistence mirrors skillCuratorService's load-mutate-save pattern but lives
 * under getDataDir('agents')/stats.json (→ ~/.khy), per the new-service rule.
 * The ledger is best-effort: any disk failure degrades to in-memory defaults
 * and never throws into a caller's hot path.
 *
 * Data shape:
 *   { "version": 1, "agents": { "<type>": {
 *       "completed": N, "reworked": N, "reworkRate": 0.0,
 *       "activeCount": N, "lastUpdatedAt": "<ISO>" } } }
 */

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../utils/dataHome');

// getDataDir(...segments) creates a DIRECTORY for every segment, so the file
// name must be joined onto the resolved 'agents' directory, not passed as a
// segment (which would create a directory literally named "stats.json").
function _statsFile() {
  return path.join(getDataDir('agents'), 'stats.json');
}

function _emptyData() {
  return { version: 1, agents: {} };
}

function _load() {
  try {
    const file = _statsFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.agents) return data;
    }
  } catch { /* corrupt/unreadable — start fresh */ }
  return _emptyData();
}

function _save(data) {
  try {
    fs.writeFileSync(_statsFile(), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* persistence is best-effort */ }
}

function _entry(data, type) {
  if (!data.agents[type]) {
    data.agents[type] = {
      completed: 0,
      reworked: 0,
      reworkRate: 0,
      activeCount: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
  }
  return data.agents[type];
}

function _clampNonNeg(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Increment the current-load counter for an agent type (subtask started).
 * @param {string} type
 * @returns {number} the new activeCount
 */
function incActive(type) {
  if (!type) return 0;
  const data = _load();
  const e = _entry(data, type);
  e.activeCount = _clampNonNeg(e.activeCount) + 1;
  e.lastUpdatedAt = new Date().toISOString();
  _save(data);
  return e.activeCount;
}

/**
 * Decrement the current-load counter for an agent type (subtask ended). Must be
 * called on EVERY exit path — success, failure, and exception — to avoid a load
 * leak. Floors at zero so a double-dec can never drive the count negative.
 * @param {string} type
 * @returns {number} the new activeCount
 */
function decActive(type) {
  if (!type) return 0;
  const data = _load();
  const e = _entry(data, type);
  e.activeCount = Math.max(0, _clampNonNeg(e.activeCount) - 1);
  e.lastUpdatedAt = new Date().toISOString();
  _save(data);
  return e.activeCount;
}

/**
 * Record a completed subtask and update the rework rate.
 * @param {string} type
 * @param {object} [opts]
 * @param {boolean} [opts.reworked] - the subtask failed or had to be retried
 * @returns {number} the new reworkRate (0..1)
 */
function recordResult(type, opts = {}) {
  if (!type) return 0;
  const data = _load();
  const e = _entry(data, type);
  e.completed = _clampNonNeg(e.completed) + 1;
  if (opts.reworked) e.reworked = _clampNonNeg(e.reworked) + 1;
  e.reworkRate = e.completed > 0 ? e.reworked / e.completed : 0;
  e.lastUpdatedAt = new Date().toISOString();
  _save(data);
  return e.reworkRate;
}

/**
 * Read the stats for an agent type. Returns zeroed defaults for an unknown type
 * (never null) so callers can use the values in arithmetic without guards.
 * @param {string} type
 * @returns {{ completed, reworked, reworkRate, activeCount, lastUpdatedAt }}
 */
function getStats(type) {
  const data = _load();
  const e = data.agents[type];
  if (!e) {
    return { completed: 0, reworked: 0, reworkRate: 0, activeCount: 0, lastUpdatedAt: null };
  }
  return {
    completed: _clampNonNeg(e.completed),
    reworked: _clampNonNeg(e.reworked),
    reworkRate: Number.isFinite(e.reworkRate) ? e.reworkRate : 0,
    activeCount: _clampNonNeg(e.activeCount),
    lastUpdatedAt: e.lastUpdatedAt || null,
  };
}

/** List every tracked agent type's stats. */
function list() {
  const data = _load();
  return Object.entries(data.agents).map(([type, e]) => ({ type, ...e }));
}

/**
 * Reset the load counters for all agent types to zero. Useful on process start
 * to clear any activeCount that leaked across an unclean shutdown.
 */
function resetActiveCounts() {
  const data = _load();
  let changed = false;
  for (const e of Object.values(data.agents)) {
    if (e.activeCount) { e.activeCount = 0; changed = true; }
  }
  if (changed) _save(data);
}

module.exports = {
  incActive,
  decActive,
  recordResult,
  getStats,
  list,
  resetActiveCounts,
};
