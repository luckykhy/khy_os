'use strict';

/**
 * accountSelector.js — Phase C-2 of the CB-SSP redesign (design doc §4.C).
 *
 * The account pool's default scheduling mode is 'Balance', yet every re-selection
 * site picked the MOST-recently-used account (`ORDER BY last_used_at DESC`) — the
 * exact opposite of balancing ("名实不符"). This module makes 'Balance'真均衡 by
 * providing the two standard load-spreading policies:
 *
 *   LRU  — always pick the LEAST-loaded account (oldest last_used_at, never-used
 *          first). Under repeated selection this is round-robin: the per-account
 *          pick counts stay within 1 of each other (perfect balance).
 *
 *   P2C  — power of two choices: sample two candidates at random, take the less
 *          loaded. Randomization avoids the thundering-herd a deterministic LRU
 *          can cause when many workers select at the same instant, while still
 *          driving the maximum load down to Θ(ln ln N) (Azar/Broder/Karlin/Upfal).
 *
 * "Load" is recency of use: a smaller last_used_at means the account has been idle
 * longer and is the better pick to spread work. Never-used accounts (null) sort
 * first. Pure functions; the RNG is injected so callers/tests are deterministic.
 * Zero hardcoding: the default policy and the tie-break are env-overridable.
 */

function _toMs(value) {
  if (value === null || value === undefined || value === '') return 0; // never used → least loaded
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

/**
 * loadKey(account) -> number   (lower = less loaded = preferred)
 * Recency of last use; never-used accounts get 0 so they are chosen first.
 */
function loadKey(account) {
  const a = account || {};
  const used = a.last_used_at !== undefined ? a.last_used_at : a.lastUsedAt;
  if (used !== undefined && used !== null && used !== '') return _toMs(used);
  // fall back to creation time so a brand-new account is preferred over a stale one
  const created = a.created_at !== undefined ? a.created_at : a.createdAt;
  return _toMs(created);
}

function _id(account) {
  const v = Number((account || {}).id);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

// Total order: least loaded first, then lowest id (deterministic tie-break).
function _lessLoaded(a, b) {
  const la = loadKey(a);
  const lb = loadKey(b);
  if (la !== lb) return la < lb ? a : b;
  return _id(a) <= _id(b) ? a : b;
}

/**
 * selectLru(accounts) -> account | null
 * The single least-loaded account (oldest last_used_at, never-used first).
 */
function selectLru(accounts = []) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  if (list.length === 0) return null;
  return list.reduce((best, cur) => (best === null ? cur : _lessLoaded(best, cur)), null);
}

/**
 * selectPowerOfTwo(accounts, rng?) -> account | null
 * Sample two distinct candidates uniformly at random and return the less loaded.
 * With 0/1 candidate it degenerates to that candidate. `rng` defaults to
 * Math.random; pass a seeded generator for determinism.
 */
function selectPowerOfTwo(accounts = [], rng = Math.random) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  if (list.length <= 1) return list[0] || null;
  const i = Math.min(list.length - 1, Math.floor(rng() * list.length));
  let j = Math.min(list.length - 1, Math.floor(rng() * list.length));
  if (j === i) j = (i + 1) % list.length; // guarantee two DISTINCT choices
  return _lessLoaded(list[i], list[j]);
}

function defaultPolicy() {
  const p = String(process.env.KHY_ACCOUNT_BALANCE_POLICY || 'p2c').toLowerCase();
  return p === 'lru' || p === 'mru' || p === 'p2c' ? p : 'p2c';
}

/**
 * policyForMode(schedulingMode) -> 'lru' | 'p2c' | 'mru'
 * Only 'Balance' mode load-balances; any other mode keeps the legacy MRU pick so
 * an operator can opt back into sticky behavior by switching the mode.
 */
function policyForMode(schedulingMode) {
  const m = String(schedulingMode || '').toLowerCase();
  return m === 'balance' ? defaultPolicy() : 'mru';
}

/**
 * pickBalanced(accounts, opts?) -> account | null
 * Applies the requested policy. 'mru' picks the MOST-loaded (legacy sticky) so
 * callers can funnel every selection site through one function.
 */
function pickBalanced(accounts = [], opts = {}) {
  const list = Array.isArray(accounts) ? accounts.filter(Boolean) : [];
  if (list.length === 0) return null;
  const policy = opts.policy || defaultPolicy();
  if (policy === 'lru') return selectLru(list);
  if (policy === 'mru') {
    // most recently used = the inverse of LRU
    return list.reduce((best, cur) => {
      if (best === null) return cur;
      const lb = loadKey(best);
      const lc = loadKey(cur);
      if (lc !== lb) return lc > lb ? cur : best;
      return _id(cur) <= _id(best) ? cur : best;
    }, null);
  }
  return selectPowerOfTwo(list, opts.rng || Math.random);
}

module.exports = {
  loadKey,
  selectLru,
  selectPowerOfTwo,
  pickBalanced,
  policyForMode,
  defaultPolicy,
};
