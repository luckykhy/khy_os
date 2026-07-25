/**
 * Concurrency Slot Manager — limits simultaneous in-flight requests per provider key.
 *
 * Each key gets a configurable maxConcurrency based on its provider type.
 * Slots are acquired before sending and released after response/error.
 * Integrates with apiKeyPool: pick() only returns keys with available slots.
 *
 * Config via environment: POOL_MAX_CONCURRENCY_<PROVIDER>=N
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

// ── State ──

/** @type {Map<string, { current: number, max: number }>} keyId → slot state */
const _slots = new Map();

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
};
