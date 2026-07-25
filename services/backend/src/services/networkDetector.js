/**
 * Network Detector Service
 *
 * Determines online/offline state to drive local-mode / offline degradation.
 *
 * Connectivity is probed by racing TCP connects against a configurable set of
 * neutral public endpoints (default: anycast DNS resolvers reachable both in
 * China and internationally). The first successful connect marks the system
 * online; the system is only declared offline when every probe fails. This is
 * resilient to a single host being down or to a captive portal blocking one
 * endpoint — unlike probing a single hardcoded host.
 *
 * Tunable via env (零硬编码 — no magic targets baked into logic):
 *   KHY_NET_PROBE_HOSTS      comma list of "host" or "host:port" (default port 443)
 *   KHY_NET_PROBE_TIMEOUT_MS per-probe connect timeout       (default 2000)
 *   KHY_NET_PROBE_INTERVAL_MS background re-check cadence     (default 300000)
 */
const net = require('net');
const logger = require('../utils/logger');

// Neutral, app-agnostic defaults: public anycast DNS resolvers on 443.
// Using IP literals avoids conflating DNS-resolution failure with the TCP
// reachability we actually want to measure. Reachable in CN and globally.
const DEFAULT_PROBE_TARGETS = [
  { host: '223.5.5.5', port: 443 },   // AliDNS (CN anycast)
  { host: '119.29.29.29', port: 443 }, // DNSPod / Tencent (CN anycast)
  { host: '1.1.1.1', port: 443 },     // Cloudflare (global)
  { host: '8.8.8.8', port: 443 },     // Google (global)
];

function _parseTargets(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const targets = [];
  for (const part of raw.split(',')) {
    const spec = part.trim();
    if (!spec) continue;
    const idx = spec.lastIndexOf(':');
    if (idx > 0 && idx < spec.length - 1) {
      const host = spec.slice(0, idx).trim();
      const port = Number(spec.slice(idx + 1).trim());
      if (host && Number.isInteger(port) && port > 0 && port <= 65535) {
        targets.push({ host, port });
        continue;
      }
    }
    targets.push({ host: spec, port: 443 });
  }
  return targets.length ? targets : null;
}

function _intFromEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

class NetworkDetector {
  constructor() {
    this._online = false;
    this._lastCheck = 0;
    this._lastReason = 'not yet checked';
    this._checking = false;
    this._initialized = false;
    this._intervalHandle = null;
    // Last logged connectivity state: null = never logged. Log only on a real
    // online/offline transition so standby does not emit a line every interval.
    this._loggedOnline = null;

    this._targets = _parseTargets(process.env.KHY_NET_PROBE_HOSTS) || DEFAULT_PROBE_TARGETS;
    this._timeoutMs = _intFromEnv('KHY_NET_PROBE_TIMEOUT_MS', 2000);
    this._cacheTTL = _intFromEnv('KHY_NET_PROBE_INTERVAL_MS', 5 * 60 * 1000);
  }

  /**
   * Initialize: run first check and start periodic re-check.
   */
  async init() {
    if (this._initialized) return;
    this._initialized = true;
    await this._doCheck();
    this._intervalHandle = setInterval(() => this._doCheck(), this._cacheTTL);
    // Background probing must not pin the event loop: let it die with the
    // main process (daemon-equivalent).
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  /**
   * Record a connectivity result, logging only on a real online/offline transition.
   * @param {boolean} online
   * @param {string} reason
   */
  _record(online, reason) {
    this._online = online;
    this._lastReason = reason;
    this._lastCheck = Date.now();
    this._checking = false;
    if (this._loggedOnline !== online) {
      this._loggedOnline = online;
      logger.info(`Network check: ${online ? 'ONLINE' : 'OFFLINE'} (${reason})`);
    }
  }

  /**
   * Race a single TCP connect against one target; resolve true on connect.
   * Never rejects — failure/timeout resolves false.
   */
  _probeOne(target) {
    return new Promise(resolve => {
      let settled = false;
      const done = ok => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* ignore */ }
        resolve(ok);
      };
      const socket = net.connect({ host: target.host, port: target.port });
      socket.setTimeout(this._timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  }

  /**
   * Probe all targets in parallel; online if any connects.
   */
  _doCheck() {
    if (this._checking) return Promise.resolve();
    this._checking = true;

    return Promise.all(this._targets.map(t => this._probeOne(t))).then(results => {
      const okIndex = results.findIndex(Boolean);
      if (okIndex >= 0) {
        const t = this._targets[okIndex];
        this._record(true, `${t.host}:${t.port} reachable`);
      } else {
        this._record(false, `all ${this._targets.length} probes failed`);
      }
    });
  }

  /**
   * Force an immediate re-check (bypasses the background cadence).
   * @returns {Promise<boolean>} resulting online state.
   */
  async checkNow() {
    this._initialized = true;
    await this._doCheck();
    return this._online;
  }

  /**
   * @returns {boolean} Whether the system is online.
   */
  isOnline() {
    // If never checked, assume offline until first check completes.
    if (!this._initialized) return false;
    return this._online;
  }

  /**
   * @returns {'online'|'offline'} Current data mode.
   */
  getDataMode() {
    return this.isOnline() ? 'online' : 'offline';
  }

  /**
   * Full connectivity state (状态透明 — surfaces freshness, not just a boolean).
   * `stale` is true when the last result is older than twice the probe cadence.
   */
  getStatus() {
    const ageMs = this._lastCheck ? Date.now() - this._lastCheck : null;
    return {
      online: this.isOnline(),
      mode: this.getDataMode(),
      initialized: this._initialized,
      checking: this._checking,
      lastCheck: this._lastCheck || null,
      ageMs,
      stale: ageMs == null ? true : ageMs > this._cacheTTL * 2,
      reason: this._lastReason,
      targets: this._targets.map(t => `${t.host}:${t.port}`),
      timeoutMs: this._timeoutMs,
      intervalMs: this._cacheTTL,
    };
  }

  /**
   * Whether a network attempt is worth making right now. PERMISSIVE by design:
   * returns true unless we hold a FRESH, confident offline reading. Never blocks
   * on an uninitialized or stale state (those fall through to true), so it can
   * only skip work we already know would fail — never cause a false offline.
   *
   * Used to short-circuit slow web-search fallbacks in forced-local mode: when
   * the detector just confirmed offline, there is no point burning a full probe
   * timeout per query before degrading to the capability menu.
   * @returns {boolean}
   */
  shouldAttemptNetwork() {
    if (!this._initialized || !this._lastCheck) return true;
    const ageMs = Date.now() - this._lastCheck;
    const fresh = ageMs <= this._cacheTTL * 2;
    // Only suppress when we are confidently AND freshly offline.
    if (fresh && !this._online) return false;
    return true;
  }

  /**
   * Stop periodic checks (for graceful shutdown).
   */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }
}

// Singleton
const detector = new NetworkDetector();

module.exports = detector;
