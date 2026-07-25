'use strict';

/**
 * approvalLedger.js — learned auto-approval ledger (借鉴分析 #6).
 *
 * Records the outcome of every permission decision per tool key and, ONLY when
 * explicitly opted in, lets low-risk routine operations the user has repeatedly
 * approved skip the prompt — a spam-filter-style trust ladder that reduces
 * interruption without ever automating high-stakes actions.
 *
 * Hard safety invariants (never relaxed):
 *   - Disabled by default. KHY_AUTO_APPROVE must be 'on' to auto-approve.
 *   - Only 'safe'/'low' risk and non-destructive ops are ever eligible.
 *   - A single denial resets the trust counter to zero.
 *   - The critical red line lives in toolCalling.js (criticalGate); a learned
 *     'allow' is ignored there for critical-risk calls. This module never sees
 *     or overrides that gate.
 *   - All disk writes are best-effort; on failure the caller falls back to ask.
 *
 * Storage: getDataDir('approvals', 'ledger.json'). No new dependencies.
 */

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../utils/dataHome');

const LEDGER_FILE = 'ledger.json';
const DEFAULT_THRESHOLD = 3;

function _ledgerPath() {
  return path.join(getDataDir('approvals'), LEDGER_FILE);
}

function _load() {
  try {
    const raw = fs.readFileSync(_ledgerPath(), 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') {
      return data;
    }
  } catch { /* missing or corrupt — start fresh */ }
  return { version: 1, entries: {} };
}

function _save(data) {
  try {
    fs.writeFileSync(_ledgerPath(), JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

function _threshold() {
  const raw = parseInt(process.env.KHY_AUTO_APPROVE_THRESHOLD || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD;
}

function _enabled() {
  return String(process.env.KHY_AUTO_APPROVE || 'off').trim().toLowerCase() === 'on';
}

function _rankSafeLow(risk) {
  // True only for safe/low; anything unknown or higher is ineligible.
  try {
    const { RISK_ORDER } = require('../constants/riskOrder');
    const r = RISK_ORDER[risk];
    return r != null && r <= RISK_ORDER.low;
  } catch {
    return risk === 'safe' || risk === 'low';
  }
}

/**
 * Record a real user decision for a tool key.
 * @param {{ key:string, decision:'allow'|'deny', risk?:string, stamp?:string }} opts
 */
function record(opts = {}) {
  const key = opts.key;
  const decision = opts.decision;
  if (!key || (decision !== 'allow' && decision !== 'deny')) return;

  const data = _load();
  const now = opts.stamp || new Date().toISOString();
  const entry = data.entries[key] || {
    allowCount: 0, denyCount: 0, lastDecision: null, lastRisk: null, firstSeen: now, lastSeen: now,
  };

  if (decision === 'allow') {
    entry.allowCount = (entry.allowCount || 0) + 1;
  } else {
    entry.denyCount = (entry.denyCount || 0) + 1;
    entry.allowCount = 0; // one denial resets accumulated trust
  }
  entry.lastDecision = decision;
  if (opts.risk) entry.lastRisk = opts.risk;
  entry.lastSeen = now;
  data.entries[key] = entry;
  _save(data);
}

/**
 * Whether a tool call may be auto-approved from learned history.
 * @param {{ key:string, risk?:string, isDestructive?:boolean }} opts
 * @returns {boolean}
 */
function shouldAutoApprove(opts = {}) {
  if (!_enabled()) return false;
  if (opts.isDestructive === true) return false;
  if (!_rankSafeLow(opts.risk)) return false;

  const entry = _load().entries[opts.key];
  if (!entry) return false;
  if ((entry.denyCount || 0) > 0) return false;
  return (entry.allowCount || 0) >= _threshold();
}

/**
 * Return the full ledger for display, annotated with eligibility.
 * @returns {{ enabled:boolean, threshold:number, entries:object }}
 */
function getLedger() {
  const data = _load();
  const threshold = _threshold();
  const enabled = _enabled();
  const entries = {};
  for (const [key, e] of Object.entries(data.entries)) {
    const autoEligible = enabled
      && (e.denyCount || 0) === 0
      && (e.allowCount || 0) >= threshold
      && _rankSafeLow(e.lastRisk);
    entries[key] = { ...e, autoEligible };
  }
  return { enabled, threshold, entries };
}

/** Clear the entire ledger. */
function reset() {
  return _save({ version: 1, entries: {} });
}

module.exports = {
  record,
  shouldAutoApprove,
  getLedger,
  reset,
  get LEDGER_PATH() { return _ledgerPath(); },
};
