'use strict';

/**
 * networkHealthMonitor — background daemon that periodically probes AI adapter health
 * and proactively clears cooldowns when the network recovers.
 *
 * Problem solved: when all channels fail due to network outage, Khyos stays dead until
 * a user request triggers the recovery loop (which times out at 120s). This module
 * ensures that:
 *   1. Adapters are probed every N seconds even when idle
 *   2. When an adapter recovers, its cooldown is cleared immediately
 *   3. The next user request can use the recovered adapter without waiting
 *
 * Usage:
 *   const monitor = getNetworkHealthMonitor({ gateway });
 *   monitor.start();   // begin background probing
 *   monitor.stop();    // clean shutdown
 *
 * Environment variables:
 *   KHY_NETWORK_MONITOR_INTERVAL_MS — probe interval (default 30000, min 10000)
 *   KHY_NETWORK_MONITOR_ENABLED — enable/disable (default 'true')
 */

const fs = require('fs');
const path = require('path');

let _instance = null;
let _gw = null;
let _timer = null;
let _running = false;
let _lastProbeResults = new Map(); // adapterKey → { ok, ts, latencyMs }
let _recoveryCount = 0;
let _listeners = [];

// ── Configuration ────────────────────────────────────────────────

function _getIntervalMs() {
  const raw = String(process.env.KHY_NETWORK_MONITOR_INTERVAL_MS || '30000').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 10000 ? Math.min(n, 120000) : 30000;
}

function _isEnabled() {
  const raw = String(process.env.KHY_NETWORK_MONITOR_ENABLED || 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object} opts.gateway — the AI gateway instance (must have testAdapter method)
 * @returns {{ start, stop, isRunning, getStatus, onRecovery }}
 */
function getNetworkHealthMonitor(opts = {}) {
  if (_instance) {
    return _instance;
  }
  _gw = opts.gateway || null;
  _instance = {
    start,
    stop,
    isRunning: () => _running,
    getStatus: () => ({
      running: _running,
      intervalMs: _getIntervalMs(),
      probes: _lastProbeResults.size,
      recoveries: _recoveryCount,
      adapters: [..._lastProbeResults.entries()].map(([key, v]) => ({
        key,
        ok: v.ok,
        latencyMs: v.latencyMs,
        lastCheck: new Date(v.ts).toISOString(),
      })),
    }),
    onRecovery: (fn) => {
      _listeners.push(fn);
      return () => {
        _listeners = _listeners.filter((l) => l !== fn);
      };
    },
  };
  return _instance;
}

// ── Core Logic ───────────────────────────────────────────────────

async function start() {
  if (_running) {
    return;
  }
  if (!_isEnabled()) {
    return;
  }
  if (!_gw) {
    try {
      _gw = require('./gateway/aiGateway');
    } catch {
      /* gateway not available */
    }
  }
  if (!_gw) {
    return;
  } // can't monitor without a gateway

  _running = true;
  const interval = _getIntervalMs();

  // Run immediately, then on interval
  _probeAll().catch(() => {});
  _timer = setInterval(() => _probeAll().catch(() => {}), interval);
  if (_timer.unref) {
    _timer.unref();
  } // don't keep process alive just for the timer
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
}

async function _probeAll() {
  if (!_running || !_gw) {
    return;
  }

  try {
    // Try to get adapter list from gateway
    const adapters = _getAdapterKeys();
    if (!adapters.length) {
      return;
    }

    const results = new Map();

    // Probe adapters in parallel with timeout
    const probePromises = adapters.map(async (key) => {
      try {
        const start = Date.now();
        const result = await _gw.testAdapter(key, { quick: true, timeoutMs: 8000 });
        const latencyMs = Date.now() - start;
        const ok = _isHealthyProbeResult(result);
        results.set(key, { ok, ts: Date.now(), latencyMs, error: null });
        return { key, ok, latencyMs };
      } catch (err) {
        results.set(key, { ok: false, ts: Date.now(), latencyMs: null, error: err.message });
        return { key, ok: false, error: err.message };
      }
    });

    const outcomes = await Promise.allSettled(probePromises);
    const succeeded = outcomes.filter((o) => o.status === 'fulfilled' && o.value.ok).length;

    // Compare with previous state to detect recoveries
    for (const [key, info] of results) {
      const prev = _lastProbeResults.get(key);
      if (!prev?.ok && info.ok) {
        // Adapter recovered! Clear its cooldown.
        _recoveryCount++;
        try {
          await _gw._clearAdapterFailure(key);
        } catch {
          /* fail-soft */
        }
        _notifyListeners({ type: 'adapter_recovered', key, latencyMs: info.latencyMs });
      }
    }

    _lastProbeResults = results;

    // If we recovered at least one adapter, log it
    if (succeeded > 0 && _lastProbeResults.size > 0) {
      const total = _lastProbeResults.size;
      const healthy = [..._lastProbeResults.values()].filter((r) => r.ok).length;
      if (healthy >= total / 2) {
        _notifyListeners({ type: 'network_recovered', healthy, total });
      }
    }
  } catch {
    // probeAll itself failed — don't crash the monitor
  }
}

function _getAdapterKeys() {
  try {
    if (_gw && typeof _gw.getAdapters === 'function') {
      return _gw
        .getAdapters()
        .map((a) => a.key)
        .filter(Boolean);
    }
    if (_gw && _gw._adapterRegistry) {
      return Object.keys(_gw._adapterRegistry);
    }
  } catch {
    /* fail-soft */
  }
  // Fallback: known adapter keys
  return ['api', 'claude', 'cursor', 'codex', 'kiro', 'trae', 'windsurf', 'ollama'];
}

function _isHealthyProbeResult(result) {
  if (!result) {
    return false;
  }
  if (result.success === false) {
    return false;
  }
  if (result.error) {
    return false;
  }
  if (result.statusCode && result.statusCode >= 400) {
    return false;
  }
  return true;
}

function _notifyListeners(event) {
  for (const fn of _listeners) {
    try {
      fn(event);
    } catch {
      /* fail-soft */
    }
  }
}

module.exports = { getNetworkHealthMonitor, start, stop, _getIntervalMs, _isEnabled };
