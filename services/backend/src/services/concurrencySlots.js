/**
 * Concurrency Slot Manager — limits simultaneous in-flight requests per provider key
 * and per user.
 *
 * Each key gets a configurable maxConcurrency based on its provider type.
 * User-level limits prevent a single user from monopolizing capacity.
 * Slots are acquired before sending and released after response/error.
 * Integrates with apiKeyPool: pick() only returns keys with available slots.
 *
 * Config via environment:
 *   POOL_MAX_CONCURRENCY_<PROVIDER>=N   (per-provider key limit)
 *   KHY_USER_MAX_CONCURRENT=N           (per-user limit, default 2)
 */

// ── Provider default concurrency limits ──

const PROVIDER_DEFAULTS = {
  relay: 5,
  deepseek: 3,
  qwen: 5,
  openai: 3,
  anthropic: 2,
  glm: 3,
  doubao: 3,
  wenxin: 2,
  kiro: 1,
  cursor: 1,
  claude: 1,
  codex: 1,
  windsurf: 1,
  vscode: 1,
  trae: 1,
};

const DEFAULT_MAX = 3;

// ── Per-user concurrency limits ──

const DEFAULT_USER_MAX_CONCURRENT = parseInt(process.env.KHY_USER_MAX_CONCURRENT, 10) || 2;
const USER_SLOT_TTL_MS = 60000; // 60s — auto-release stale slots

// ── State ──

/** @type {Map<string, { current: number, max: number }>} keyId → slot state */
const _slots = new Map();

/** @type {Map<string, { current: number, max: number, entries: Array<{ts: number}> }>} userId → user slot */
const _userSlots = new Map();

// ── Public API ──

/**
 * Register a key with its provider-based concurrency limit.
 * Safe to call multiple times (idempotent for existing keys).
 * @param {string} keyId
 * @param {string} provider
 */
function register(keyId, provider) {
  if (_slots.has(keyId)) return;

  // Check environment override first
  const envKey = `POOL_MAX_CONCURRENCY_${provider.toUpperCase()}`;
  const envVal = process.env[envKey];
  const max = envVal ? parseInt(envVal, 10) || DEFAULT_MAX
    : PROVIDER_DEFAULTS[provider] ?? DEFAULT_MAX;

  _slots.set(keyId, { current: 0, max });
}

/**
 * Acquire a slot for a key. Increments in-flight counter.
 * Returns a release function that MUST be called after the request completes.
 * @param {string} keyId
 * @returns {(() => void)|null} release function, or null if key not registered
 */
function acquire(keyId) {
  const slot = _slots.get(keyId);
  if (!slot) return null;

  slot.current++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    slot.current = Math.max(0, slot.current - 1);
  };
}

/**
 * Release a slot directly by keyId (alternative to calling the release function).
 * @param {string} keyId
 */
function release(keyId) {
  const slot = _slots.get(keyId);
  if (slot) slot.current = Math.max(0, slot.current - 1);
}

/**
 * Check if a key has available concurrency slots.
 * @param {string} keyId
 * @returns {boolean}
 */
function hasAvailableSlot(keyId) {
  const slot = _slots.get(keyId);
  if (!slot) return true; // unregistered keys are unlimited
  return slot.current < slot.max;
}

/**
 * Get slot status for a key.
 * @param {string} keyId
 * @returns {{ current: number, max: number, available: number }|null}
 */
function getSlotStatus(keyId) {
  const slot = _slots.get(keyId);
  if (!slot) return null;
  return { current: slot.current, max: slot.max, available: slot.max - slot.current };
}

/**
 * Update max concurrency for a specific key.
 * @param {string} keyId
 * @param {number} max
 */
function setMaxSlots(keyId, max) {
  const slot = _slots.get(keyId);
  if (slot) slot.max = Math.max(1, max);
}

/**
 * Get all slot states (for status display).
 * @returns {Object<string, { current, max, available }>}
 */
function getAllStatus() {
  const result = {};
  for (const [keyId, slot] of _slots) {
    result[keyId] = { current: slot.current, max: slot.max, available: slot.max - slot.current };
  }
  return result;
}

/**
 * Remove a key from slot tracking (when key is removed from pool).
 * @param {string} keyId
 */
function unregister(keyId) {
  _slots.delete(keyId);
}

/**
 * Reset all slot counters (useful for error recovery).
 */
function resetAll() {
  for (const slot of _slots.values()) {
    slot.current = 0;
  }
  _userSlots.clear();
}

// ── User-level concurrency ──

/**
 * Acquire a user-level concurrency slot.
 * @param {string} userId
 * @returns {(() => void)|null} Release function, or null if limit reached
 */
function acquireUser(userId) {
  if (!userId) return () => {}; // No user tracking for anonymous

  let slot = _userSlots.get(userId);
  if (!slot) {
    const max = parseInt(process.env.KHY_USER_MAX_CONCURRENT, 10) || DEFAULT_USER_MAX_CONCURRENT;
    slot = { current: 0, max, entries: [] };
    _userSlots.set(userId, slot);
  }

  // Prune stale entries
  const now = Date.now();
  slot.entries = slot.entries.filter(e => (now - e.ts) < USER_SLOT_TTL_MS);
  slot.current = slot.entries.length;

  if (slot.current >= slot.max) {
    return null; // Limit reached
  }

  const entry = { ts: now };
  slot.entries.push(entry);
  slot.current++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const idx = slot.entries.indexOf(entry);
    if (idx >= 0) slot.entries.splice(idx, 1);
    slot.current = Math.max(0, slot.current - 1);
  };
}

/**
 * Check if a user has available concurrency slots.
 * @param {string} userId
 * @returns {boolean}
 */
function hasUserSlot(userId) {
  if (!userId) return true;
  const slot = _userSlots.get(userId);
  if (!slot) return true;
  // Prune stale
  const now = Date.now();
  slot.entries = slot.entries.filter(e => (now - e.ts) < USER_SLOT_TTL_MS);
  slot.current = slot.entries.length;
  return slot.current < slot.max;
}

/**
 * Get user slot status.
 * @param {string} userId
 * @returns {{ current: number, max: number, available: number }|null}
 */
function getUserSlotStatus(userId) {
  if (!userId) return null;
  const slot = _userSlots.get(userId);
  if (!slot) return { current: 0, max: DEFAULT_USER_MAX_CONCURRENT, available: DEFAULT_USER_MAX_CONCURRENT };
  const now = Date.now();
  slot.entries = slot.entries.filter(e => (now - e.ts) < USER_SLOT_TTL_MS);
  slot.current = slot.entries.length;
  return { current: slot.current, max: slot.max, available: slot.max - slot.current };
}

module.exports = {
  register,
  acquire,
  release,
  hasAvailableSlot,
  getSlotStatus,
  setMaxSlots,
  getAllStatus,
  unregister,
  resetAll,
  // User-level concurrency
  acquireUser,
  hasUserSlot,
  getUserSlotStatus,
};
