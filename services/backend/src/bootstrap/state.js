/**
 * Bootstrap State — centralized process-level singleton.
 *
 * Tracks infrastructure-level state that is shared across the CLI entry,
 * server, and REPL.  Module-scope singleton via Node's require cache.
 *
 * DO NOT ADD MORE STATE HERE — be judicious with global state.
 * REPL UI state (_busy, _planMode, etc.) stays in repl.js.
 * Service-internal state stays within each service module.
 */

const _state = {
  // Process lifecycle
  initialized: false,       // Has init() completed?
  sessionReady: false,       // Has setup() completed?
  mode: null,                // 'khy' | 'khyquant' — set by entry point
  shutdownRequested: false,  // Has graceful shutdown begun?

  // Database
  dbConnected: false,
  dbMode: null,              // 'sqlite' | 'postgres' | null

  // Server
  serverPid: null,           // PID of spawned server child process
  activePort: null,          // Bound HTTP port

  // Bootstrap metadata
  bootstrapVersion: null,    // Last applied migration version

  // Profiler reference (convenience for diagnostics)
  startupProfiler: null,
};

/**
 * Get a state value.
 * @param {string} key
 * @returns {*}
 */
function get(key) {
  if (!(key in _state)) {
    throw new Error(`Bootstrap state: unknown key "${key}"`);
  }
  return _state[key];
}

/**
 * Set a state value.
 * @param {string} key
 * @param {*} value
 */
function set(key, value) {
  if (!(key in _state)) {
    throw new Error(`Bootstrap state: unknown key "${key}"`);
  }
  _state[key] = value;
}

/**
 * Return a frozen shallow copy of the full state (for diagnostics / logging).
 */
function snapshot() {
  return Object.freeze({ ..._state });
}

module.exports = { get, set, snapshot };
