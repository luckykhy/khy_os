/**
 * Channel Health Broadcaster
 *
 * Periodically polls the RedisHealthStore for adapter state changes
 * and broadcasts updates via WebSocket to connected clients.
 * Also records per-request activity events (attempt, success, failure, fallback).
 */
'use strict';

const BROADCAST_INTERVAL_MS = parseInt(
  process.env.GATEWAY_HEALTH_BROADCAST_INTERVAL_MS || '5000', 10
);
const ENABLED = String(process.env.GATEWAY_HEALTH_BROADCAST_ENABLED || 'true').toLowerCase() !== 'false';

class ChannelHealthBroadcaster {
  /**
   * @param {object} opts
   * @param {import('./redisHealthStore').RedisHealthStore} opts.healthStore
   * @param {Function} [opts.broadcast] — (type, data) => void (WebSocket broadcast fn)
   * @param {string[]} [opts.adapterKeys] — list of adapter keys to monitor
   */
  constructor(opts = {}) {
    this._healthStore = opts.healthStore;
    this._broadcast = opts.broadcast || (() => {});
    this._adapterKeys = opts.adapterKeys || [];
    this._timer = null;
    this._lastSnapshot = null;
    this._listeners = [];
    this._activityRing = []; // ring buffer of last 50 events
  }

  /**
   * Update the list of adapter keys to monitor.
   */
  setAdapterKeys(keys) {
    this._adapterKeys = keys || [];
  }

  /**
   * Start periodic health polling.
   */
  start() {
    if (!ENABLED || this._timer) return;
    this._timer = setInterval(() => this._poll(), BROADCAST_INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
    // Initial poll
    this._poll();
  }

  /**
   * Stop polling.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Register a listener for health changes (programmatic use).
   */
  onHealthChange(callback) {
    this._listeners.push(callback);
  }

  /**
   * Record a request activity event.
   * @param {string} adapterKey
   * @param {'attempt'|'success'|'failure'|'fallback'} event
   * @param {string} [detail]
   */
  recordRequestActivity(adapterKey, event, detail = '') {
    if (!ENABLED) return;
    const entry = {
      adapter: adapterKey,
      event,
      detail: String(detail || '').slice(0, 200),
      timestamp: Date.now(),
    };
    this._activityRing.push(entry);
    if (this._activityRing.length > 50) this._activityRing.shift();

    // Broadcast immediately
    try {
      this._broadcast('channel_activity', entry);
    } catch { /* best effort */ }
  }

  /**
   * Get current health snapshot.
   */
  async getSnapshot() {
    if (!this._healthStore || this._adapterKeys.length === 0) {
      return { adapters: [], timestamp: Date.now() };
    }
    try {
      const states = await this._healthStore.getAllAdapterStates(this._adapterKeys);
      const adapters = this._adapterKeys.map(key => {
        const s = states[key] || {};
        let circuitState = 'closed';
        if (s.inCooldown) circuitState = 'open';
        else if (s.failureCount > 0 && s.consecutiveSuccesses > 0) circuitState = 'half-open';

        return {
          key,
          status: s.inCooldown ? 'cooldown' : (s.failureCount > 0 ? 'degraded' : 'healthy'),
          failureCount: s.failureCount || 0,
          cooldownRemainingMs: s.cooldownRemainingMs || 0,
          circuitState,
          lastError: s.lastError ? s.lastError.errorType : null,
        };
      });
      return { adapters, timestamp: Date.now() };
    } catch {
      return { adapters: [], timestamp: Date.now() };
    }
  }

  /**
   * Get recent activity ring buffer.
   */
  getRecentActivity() {
    return this._activityRing.slice(-20);
  }

  // ── Internal ────────────────────────────────────────────────────────────

  async _poll() {
    try {
      const snapshot = await this.getSnapshot();
      const serialized = JSON.stringify(snapshot.adapters);

      // Only broadcast if changed
      if (serialized !== this._lastSnapshot) {
        this._lastSnapshot = serialized;
        this._broadcast('channel_health', snapshot);
        for (const fn of this._listeners) {
          try { fn(snapshot); } catch { /* ignore */ }
        }
      }
    } catch { /* polling should never crash */ }
  }
}

module.exports = { ChannelHealthBroadcaster };
