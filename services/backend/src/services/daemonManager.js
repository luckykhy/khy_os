'use strict';

/**
 * Daemon Manager — start/stop/status/restart the KHY AI daemon process.
 *
 * The daemon runs aiManagementServer (HTTP+WS on port 9090) as a detached
 * background process. PID and port are stored in ~/.khyquant/daemon.pid.
 */
const { spawn } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { getDataDir, getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const PID_FILE = path.join(getDataDir(), 'daemon.pid');
const LOG_FILE = path.join(getDataDir('logs'), 'daemon.log');
const DAEMON_ENTRY = path.join(__dirname, 'daemonEntry.js');
const DEFAULT_PORT = parseInt(process.env.KHY_DAEMON_PORT || '9090', 10);
const RUNTIME_FILE = path.join(getDataHome(), 'ai_manage_runtime.json');
const LEGACY_RUNTIME_FILE = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');

/**
 * Read the PID file.
 * @returns {{ pid: number, port: number, startedAt: number } | null}
 */
function _readPidFile() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _writePidFile(info) {
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

function _toPort(raw, fallback = null) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function _readRuntimeFile() {
  for (const filePath of [RUNTIME_FILE, LEGACY_RUNTIME_FILE]) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const apiPort = _toPort(raw?.apiPort);
      if (!apiPort) continue;
      return {
        pid: Number(raw?.pid) || null,
        apiPort,
        updatedAt: Number(raw?.updatedAt) || 0,
        source: filePath,
      };
    } catch { /* try next */ }
  }
  return null;
}

function _resolveLivePort(info, runtime) {
  const requestedPort = _toPort(info?.port);
  if (!runtime || !runtime.apiPort) return requestedPort;
  if (runtime.pid && info?.pid && Number(runtime.pid) !== Number(info.pid)) {
    return requestedPort;
  }
  return runtime.apiPort;
}

/**
 * Check if a process is alive.
 * @param {number} pid
 * @returns {boolean}
 */
function _isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the daemon process.
 * @param {object} [opts]
 * @param {number} [opts.port] - Port for HTTP/WS server
 * @returns {{ pid: number, port: number }}
 */
function daemonStart(opts = {}) {
  const existing = _readPidFile();
  if (existing && _isAlive(existing.pid)) {
    throw new Error(`Daemon already running (PID ${existing.pid}, port ${existing.port})`);
  }

  const port = opts.port || DEFAULT_PORT;

  // Open log file for append
  let logFd;
  try {
    logFd = fs.openSync(LOG_FILE, 'a');
  } catch (err) {
    throw new Error(`Cannot open daemon log file: ${err.message}`);
  }

  let child;
  try {
    child = spawn(process.execPath, [DAEMON_ENTRY], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        KHY_DAEMON_PORT: String(port),
        KHY_DAEMON_PID_FILE: PID_FILE,
      },
    });
  } catch (err) {
    fs.closeSync(logFd);
    throw err;
  }

  child.on('error', () => { /* detached — best effort */ });

  // Write PID file
  const info = {
    pid: child.pid,
    port,
    startedAt: Date.now(),
    nodeVersion: process.version,
  };
  fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2), 'utf-8');

  child.unref();
  fs.closeSync(logFd);

  return { pid: child.pid, port };
}

/**
 * Stop the daemon process.
 * @returns {boolean}
 */
function daemonStop() {
  const info = _readPidFile();
  if (!info) return false;

  if (_isAlive(info.pid)) {
    safeKill(info.pid, 'SIGTERM', 3000);
    // Wait for process to exit
    const deadline = Date.now() + 5000;
    while (_isAlive(info.pid) && Date.now() < deadline) {
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }

  // Remove PID file
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  return true;
}

/**
 * Get daemon status.
 * @returns {{ running: boolean, pid: number|null, port: number|null, uptime: number|null, health: object|null }}
 */
async function daemonStatus() {
  const info = _readPidFile();
  if (!info || !_isAlive(info.pid)) {
    // Clean up stale PID file
    if (info) try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { running: false, pid: null, port: null, uptime: null, health: null };
  }

  const uptime = Date.now() - info.startedAt;
  const runtime = _readRuntimeFile();
  const livePort = _resolveLivePort(info, runtime);

  if (livePort && livePort !== info.port) {
    _writePidFile({
      ...info,
      port: livePort,
    });
  }

  // Probe health endpoint
  let health = null;
  try {
    if (livePort) {
      health = await _httpGet(`http://127.0.0.1:${livePort}/api/health`, 3000);
    }
  } catch { /* not responding yet */ }

  // scale-to-zero 只读建议(scaleToZeroPolicy 纯叶子;门 KHY_GATEWAY_SCALE_TO_ZERO,opt-in 默认关)。
  // 闲置以 runtime.updatedAt(缺则 startedAt)为粗粒度代理。仅呈现建议,绝不据此自动关停。fail-soft。
  const idleMs = Date.now() - (runtime && runtime.updatedAt ? runtime.updatedAt : info.startedAt);
  let scaleToZero = null;
  try {
    scaleToZero = require('./gateway/scaleToZeroPolicy')
      .describeScaleDecision({ idleMs, activeRequests: 0 }, process.env);
  } catch { /* fail-soft: 顾问字段缺失不影响 status */ }

  return {
    running: true,
    pid: info.pid,
    port: livePort,
    uptime,
    health,
    scaleToZero,
  };
}

/**
 * Restart the daemon.
 * @param {object} [opts]
 * @returns {{ pid: number, port: number }}
 */
function daemonRestart(opts = {}) {
  daemonStop();
  return daemonStart(opts);
}

/**
 * Get the log file path.
 * @returns {string}
 */
function getLogPath() {
  return LOG_FILE;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function _httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = {
  daemonStart,
  daemonStop,
  daemonStatus,
  daemonRestart,
  getLogPath,
};
