'use strict';

/**
 * aiManageDaemonLifecycle.js — start / query / shut down the khychat daemon
 * on demand.
 *
 * Why this exists
 *   The khychat page (apps/ai-frontend) needs the AI management backend
 *   (`services/backend/scripts/ai-manage-daemon.js`, listens on 9090 by
 *   default) to serve `/api/auth/*` and the rest of the SPA routes. Until
 *   now, the only way to bring it up was an explicit `khy gateway server`.
 *   This module is the missing "auto-spawn when the user opens khychat / types
 *   `khy`" glue. It also lets a long-lived monolith backend (server.js)
 *   answer a small `/api/daemon/ensure` route so the frontend can ask "is
 *   the daemon up? if not, start it" without holding the request open.
 *
 * What it does, exactly
 *   - Reads `~/.khy/ai_manage_runtime.json` (the daemon's published state) to
 *     find an already-running instance and its control-port / control-token.
 *     If found and the control port answers, we are done — return "running".
 *   - Otherwise spawn `node services/backend/scripts/ai-manage-daemon.js` as
 *     a fully detached child process, wait up to N seconds for the runtime
 *     file to be published, and report "running" or "failed".
 *   - On `requestShutdown`, post to the daemon's control API
 *     (`POST /shutdown` with the X-Control-Token header). Best-effort,
 *     never throws.
 *
 * What it never does
 *   - No I/O at import time. The whole module is a state machine with
 *     on-demand process spawn.
 *   - No environment assumption: when KHY_DAEMON_AUTO_SPAWN is off, the
 *     module is a no-op (returns {state:'skipped'}).
 *   - No knowledge of HTTP, JWT, or any business surface — keeps the
 *     coupling to the daemon one-way (we read its runtime, we post to its
 *     control API; we never read its business endpoints).
 *
 * Defaults (all env-overridable)
 *   KHY_DAEMON_AUTO_SPAWN=true   master switch (default: on)
 *   KHY_DAEMON_RUNTIME_FILE     override the runtime JSON path (default:
 *                                ~/.khy/ai_manage_runtime.json)
 *   KHY_DAEMON_SCRIPT           override the spawn script (default: resolved
 *                                from this module's location)
 *   KHY_DAEMON_SPAWN_TIMEOUT_MS wait-for-runtime timeout (default 15000)
 *   KHY_DAEMON_NODE             node binary to spawn (default: process.execPath)
 *
 * Idempotency
 *   Module-level single-flight: concurrent ensureStarted() callers share one
 *   promise. If a spawn is in flight, the second caller awaits the same
 *   promise — no double spawn, no race.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_RUNTIME_FILE = 'ai_manage_runtime.json';
const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;
const STATUS_PROBE_TIMEOUT_MS = 1_500;

// ── Env helpers ──────────────────────────────────────────────────────────

function _boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  if (['', '1', 'true', 'yes', 'on'].includes(v)) return true;
  return fallback;
}

function _isAutoSpawnEnabled() {
  return _boolEnv('KHY_DAEMON_AUTO_SPAWN', true);
}

function _runtimeFile() {
  return path.resolve(
    process.env.KHY_DAEMON_RUNTIME_FILE ||
      path.join(
        process.env.KHY_DATA_HOME || path.join(require('os').homedir(), '.khy'),
        DEFAULT_RUNTIME_FILE
      )
  );
}

function _scriptPath() {
  if (process.env.KHY_DAEMON_SCRIPT) {
    return path.resolve(process.env.KHY_DAEMON_SCRIPT);
  }
  // this file: services/backend/src/services/aiManageDaemonLifecycle.js
  // script:    services/backend/scripts/ai-manage-daemon.js
  return path.resolve(__dirname, '..', '..', 'scripts', 'ai-manage-daemon.js');
}

// ── Runtime file IO (sync, deliberately — we are about to spawn) ─────────

function readRuntime() {
  try {
    const raw = fs.readFileSync(_runtimeFile(), 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM on Windows when integrity levels differ → still "alive".
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Probe the daemon's control API. Best-effort, never throws.
 * Returns { ok: true, port, token, runtime } on success, { ok: false } on
 * any network / parse / auth failure. We hit `/status` (read-only) so a
 * successful probe doubles as a "daemon is healthy" signal.
 */
function probeControl(runtime) {
  return new Promise((resolve) => {
    if (!runtime || !runtime.controlPort || !runtime.controlToken) {
      return resolve({ ok: false });
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: runtime.controlPort,
        method: 'GET',
        path: '/status',
        headers: { 'X-Control-Token': runtime.controlToken },
        timeout: STATUS_PROBE_TIMEOUT_MS,
      },
      (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok ? { ok: true, runtime } : { ok: false });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.end();
  });
}

// ── Spawn ───────────────────────────────────────────────────────────────

/**
 * Spawn the daemon as a detached child. The child must outlive us (the
 * caller is often a one-shot HTTP handler or a CLI command), so:
 *   - detached: true
 *   - stdio: 'ignore' (the daemon owns its own log files)
 *   - windowsHide: true (re-applied here defensively even though
 *     bin/khy.js already installs the global patch — keeps this leaf
 *     safe when imported from a non-bin path)
 *
 * Returns { ok, pid } or { ok: false, error }.
 */
function spawnDaemon() {
  const script = _scriptPath();
  if (!fs.existsSync(script)) {
    return { ok: false, error: `daemon script not found: ${script}` };
  }
  const nodeBin = process.env.KHY_DAEMON_NODE || process.execPath;
  let child;
  try {
    child = spawn(nodeBin, [script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(_scriptPath()),
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'spawn_failed' };
  }
  // Allow the parent to exit without taking the daemon with it.
  if (typeof child.unref === 'function') child.unref();
  return { ok: true, pid: child.pid || 0 };
}

/**
 * Wait for the daemon to publish its runtime file. Polls every 250 ms.
 * Returns the runtime object on success, or null on timeout.
 */
async function waitForRuntime(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rt = readRuntime();
    if (rt && rt.pid && isPidAlive(rt.pid)) {
      // Give the control listener a beat to bind too.
      const probed = await probeControl(rt);
      if (probed.ok) return rt;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// ── Module state (single-flight) ──────────────────────────────────────────

let _state = {
  status: 'idle', // 'idle' | 'pending' | 'running' | 'failed' | 'skipped'
  runtime: null, // last known runtime JSON
  lastError: null,
  lastCheckedAt: 0,
  // Single-flight: if ensureStarted() is called while a spawn is in flight,
  // all callers share the same promise. Once resolved/rejected, the next
  // ensureStarted() call starts a new attempt.
  inflight: null,
};

function _record(status, extra = {}) {
  _state = {
    ..._state,
    status,
    lastCheckedAt: Date.now(),
    ...extra,
  };
  return _state;
}

/**
 * Idempotent entry point. If the daemon is already up, returns
 * {state:'running', runtime} immediately. If not, spawns + waits. Concurrent
 * callers share one promise. Returns one of:
 *
 *   { state: 'running', runtime }
 *   { state: 'skipped', reason: 'disabled' }   — KHY_DAEMON_AUTO_SPAWN=false
 *   { state: 'failed',  reason: string, error: string }
 */
async function ensureStarted(opts = {}) {
  if (!_isAutoSpawnEnabled()) {
    _record('skipped', { lastError: null, runtime: null });
    return { state: 'skipped' };
  }

  // Fast path: if a recent probe already found the daemon running, skip the
  // probe for 2 seconds. The runtime file is mtime-stable in that window.
  const now = Date.now();
  if (_state.status === 'running' && _state.runtime && now - _state.lastCheckedAt < 2000) {
    return { state: 'running', runtime: _state.runtime, lastError: null };
  }

  // Already running per the runtime file? Cheap probe before any spawn.
  const liveRuntime = readRuntime();
  if (liveRuntime && liveRuntime.pid && isPidAlive(liveRuntime.pid)) {
    const probed = await probeControl(liveRuntime);
    if (probed.ok) {
      _record('running', { runtime: liveRuntime, lastError: null });
      return { state: 'running', runtime: liveRuntime, lastError: null };
    }
  }

  // Single-flight: a concurrent caller may already be spawning.
  if (_state.inflight) {
    return _state.inflight;
  }

  // Build the in-flight promise as a Promise that resolves when the IIFE
  // finishes. The IIFE is scheduled to run on the next microtask so the
  // outer call's `return _state.inflight` is reached BEFORE any code in
  // the IIFE body starts — guaranteeing the caller's awaited reference is
  // never null and never gets cleared before it resolves.
  let resolveOuter;
  const inflight = new Promise((resolve) => {
    resolveOuter = resolve;
  });
  _state.inflight = inflight;

  // Defer body to a microtask so the outer `return inflight` runs first.
  queueMicrotask(() => {
    Promise.resolve()
      .then(() => _runInflight(opts, resolveOuter))
      .catch((e) => {
        // Belt-and-suspenders: _runInflight already has its own try/catch,
        // but if anything escapes (programming error, infra panic) we still
        // owe the caller a settled promise.
        const err = (e && e.message) || 'inflight_panic';
        _record('failed', { lastError: err });
        try {
          resolveOuter({ state: 'failed', runtime: null, lastError: err });
        } catch {
          /* resolveOuter may already have been called; ignore */
        }
      })
      .finally(() => {
        if (_state.inflight === inflight) _state.inflight = null;
      });
  });

  return inflight;
}

async function _runInflight(opts, resolveOuter) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_SPAWN_TIMEOUT_MS;
  try {
    _record('pending', { lastError: null });
    const spawned = spawnDaemon();
    if (!spawned.ok) {
      _record('failed', { lastError: spawned.error });
      resolveOuter({ state: 'failed', runtime: null, lastError: spawned.error });
      return;
    }
    const rt = await waitForRuntime(timeoutMs);
    if (!rt) {
      _record('failed', { lastError: 'startup_timeout' });
      resolveOuter({ state: 'failed', runtime: null, lastError: 'startup_timeout' });
      return;
    }
    _record('running', { runtime: rt });
    resolveOuter({ state: 'running', runtime: rt, lastError: null });
  } catch (e) {
    const err = (e && e.message) || 'unknown';
    _record('failed', { lastError: err });
    resolveOuter({ state: 'failed', runtime: null, lastError: err });
  }
}

/**
 * Best-effort shutdown. Talks to the daemon's control API; if no daemon is
 * running, returns { ok: true, reason: 'not_running' }. Never throws.
 */
async function requestShutdown() {
  const rt = readRuntime();
  if (!rt || !rt.controlPort || !rt.controlToken || !isPidAlive(rt.pid)) {
    _record('idle', { runtime: null, lastError: null });
    return { ok: true, reason: 'not_running' };
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: rt.controlPort,
        method: 'POST',
        path: '/shutdown',
        headers: { 'X-Control-Token': rt.controlToken },
        timeout: STATUS_PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        _record('idle', { runtime: null, lastError: null });
        resolve({ ok: res.statusCode === 200, reason: 'requested' });
      }
    );
    req.on('error', () => resolve({ ok: false, reason: 'control_unreachable' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'control_timeout' });
    });
    req.end();
  });
}

/**
 * Non-blocking kick. Used by CLI bin/khy.js hooks and Vue mount handlers.
 * Errors are swallowed (the caller never awaits anything); only an stderr
 * line is written when something went wrong.
 */
function kickstartInBackground(reason = 'unknown') {
  ensureStarted().then(
    (result) => {
      if (result.state === 'failed' && process.env.KHY_DAEMON_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.warn(`[aiManageDaemonLifecycle] kickstart(${reason}) failed: ${result.lastError || 'unknown'}`);
      }
    },
    () => {
      /* ensureStarted() never throws, but be paranoid */
    }
  );
}

/**
 * Status snapshot for /api/daemon/status and CLI introspection.
 */
function snapshot() {
  return {
    state: _state.status,
    runtime: _state.runtime,
    lastError: _state.lastError,
    lastCheckedAt: _state.lastCheckedAt,
    enabled: _isAutoSpawnEnabled(),
    script: _scriptPath(),
    runtimeFile: _runtimeFile(),
  };
}

// For tests: reset module state between cases.
function _resetForTests() {
  _state = {
    status: 'idle',
    runtime: null,
    lastError: null,
    lastCheckedAt: 0,
    inflight: null,
  };
}

module.exports = {
  ensureStarted,
  requestShutdown,
  kickstartInBackground,
  snapshot,
  readRuntime,
  probeControl,
  isPidAlive,
  // Exposed for tests / advanced callers
  _resetForTests,
  _scriptPath,
  _runtimeFile,
  _isAutoSpawnEnabled,
};
