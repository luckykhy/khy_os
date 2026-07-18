'use strict';

/**
 * Daemon Entry Point — runs the AI management server as a background daemon.
 *
 * This file is spawned by daemonManager.daemonStart() as a detached process.
 * It loads aiManagementServer and keeps running until SIGTERM/SIGINT.
 */

// Windows: hide child-process console windows before loading any module that may
// spawn (aiManagementServer's tree). Prevents the "black box flicker" on daemon
// startup. Reuses the central patch (win32-only, gated KHY_WINDOWS_SPAWN_HIDE,
// idempotent, fail-soft); no-op on non-win32.
try { require('../bootstrap/windowsSpawnHardening').installWindowsSpawnHardening(); } catch { /* best effort */ }

const fs = require('fs');
const path = require('path');
const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const PORT = parseInt(process.env.KHY_DAEMON_PORT || '9090', 10);
const PID_FILE = process.env.KHY_DAEMON_PID_FILE || '';
const RUNTIME_FILE = path.join(getDataHome(), 'ai_manage_runtime.json');
const LEGACY_RUNTIME_FILE = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');
const STARTUP_AT = Date.now();

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] [daemon] ${msg}\n`);
}

// ── Startup ─────────────────────────────────────────────────────────────

log(`Starting KHY daemon on port ${PORT} (PID ${process.pid})`);

// Ensure the JWT signing secret exists before serving any login request.
// The daemon inherits process.env from the CLI (which normally provisions it
// via bootstrap/init), but a directly-spawned daemon self-heals here too:
// ensureJwtSecret reads the canonical .env from disk and provisions if absent.
try {
  require('../bootstrap/ensureAuthSecret').ensureJwtSecret({ log: (m) => log(m) });
} catch (err) {
  log(`ensureJwtSecret skipped: ${err.message}`);
}

let server = null;
let _actualPort = PORT;
let _shutdownStarted = false;
let _shutdownDone = false;
let _shutdownLastActivityAt = 0;
let _shutdownWatchdog = null;
const SHUTDOWN_IDLE_LIMIT_MS = 5000;
const SHUTDOWN_WATCHDOG_TICK_MS = 500;

/**
 * 写运行时文件，供 CLI / 前端 / daemonClient 发现实际端口。
 * 格式与 ai-manage-daemon.js writeRuntime() 保持兼容。
 */
function writeRuntime() {
  const payload = {
    pid: process.pid,
    apiPort: _actualPort,
    startupAt: STARTUP_AT,
    updatedAt: Date.now(),
    source: 'daemonEntry',
  };
  const json = JSON.stringify(payload, null, 2);
  for (const file of [RUNTIME_FILE, LEGACY_RUNTIME_FILE]) {
    try {
      const dir = path.dirname(file);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, json, 'utf-8');
    } catch { /* best effort */ }
  }
}

function writePidFile() {
  if (!PID_FILE) return;
  const payload = {
    pid: process.pid,
    port: _actualPort,
    startedAt: STARTUP_AT,
    nodeVersion: process.version,
  };
  try {
    const dir = path.dirname(PID_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PID_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch { /* best effort */ }
}

function clearRuntime() {
  for (const file of [RUNTIME_FILE, LEGACY_RUNTIME_FILE]) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

function touchShutdownActivity() {
  _shutdownLastActivityAt = Date.now();
}

function clearShutdownWatchdog() {
  if (_shutdownWatchdog) {
    clearInterval(_shutdownWatchdog);
    _shutdownWatchdog = null;
  }
}

function startShutdownWatchdog() {
  if (_shutdownWatchdog) return;
  _shutdownWatchdog = setInterval(() => {
    if (_shutdownDone) {
      clearShutdownWatchdog();
      return;
    }
    const idleMs = Date.now() - _shutdownLastActivityAt;
    if (idleMs <= SHUTDOWN_IDLE_LIMIT_MS) return;
    log(`Shutdown idle for ${idleMs}ms, forcing exit`);
    process.exit(0);
  }, SHUTDOWN_WATCHDOG_TICK_MS);
  if (typeof _shutdownWatchdog.unref === 'function') _shutdownWatchdog.unref();
}

async function start() {
  try {
    // Try to load aiManagementServer
    const mgmtServer = require('./aiManagementServer');
    if (typeof mgmtServer.start === 'function') {
      // start(port) 接收数字参数，返回实际绑定端口（可能因端口冲突自增）
      _actualPort = await mgmtServer.start(PORT);
      if (typeof _actualPort !== 'number') _actualPort = PORT;
      log(`Management server started on port ${_actualPort}`);
    } else if (typeof mgmtServer.createServer === 'function') {
      server = mgmtServer.createServer({ port: PORT });
      _actualPort = PORT;
      log(`Management server created on port ${PORT}`);
    } else {
      // Fallback: start a simple health endpoint
      const http = require('http');
      server = http.createServer((req, res) => {
        if (req.url === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', pid: process.pid, uptime: process.uptime() }));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });
      server.listen(PORT, '127.0.0.1', () => {
        log(`Health endpoint started on port ${PORT}`);
      });
    }

    // 写运行时文件，供其他组件发现实际端口
    writeRuntime();
    writePidFile();
    log(`Runtime file written (apiPort=${_actualPort})`);

    // Restore persisted sessions
    try {
      const sessionPersistence = require('./sessionPersistence');
      const sessions = sessionPersistence.listPersistedSessions();
      log(`Found ${sessions.length} persisted sessions`);
    } catch { /* sessionPersistence not available */ }

    // 后台常驻「改动反馈 watcher」：其它 AI 改了 khy 源码时,khyos 不再一声不吭 ——
    // 周期性侦测改动、跑机器校验、判出对/不对,落盘成 verdict 供 AI 下一轮消费。
    // 门控 KHY_CHANGE_WATCH 默认开;best-effort,失败不影响守护进程主流程。
    try {
      const changeWatch = require('./changeWatchService');
      if (changeWatch.isWatchEnabled(process.env)) {
        const r = await changeWatch.start({});
        if (r && r.started) log(`Change-watch resident started (interval=${r.intervalMs}ms)`);
      }
    } catch (e) { log(`Change-watch not started: ${e && e.message ? e.message : e}`); }

  } catch (err) {
    // 红线：守护进程启动失败也要给真实原因 + 解决方案，而非裸 exit 1。
    try {
      const { describeCliError } = require('./cliErrorDescriptor');
      const desc = describeCliError(err, { context: '守护进程启动' });
      log(`Failed to start: ${desc.reason}`);
      desc.suggestions.forEach((s, i) => log(`  fix[${i + 1}]: ${s}`));
    } catch {
      log(`Failed to start: ${err && err.message ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

// ── Signal handling ─────────────────────────────────────────────────────

function shutdown(signal) {
  if (_shutdownDone) return;
  touchShutdownActivity();

  if (_shutdownStarted) {
    log(`Received ${signal} while shutdown already in progress`);
    return;
  }
  _shutdownStarted = true;
  log(`Received ${signal}, shutting down...`);
  startShutdownWatchdog();

  if (server) {
    if (typeof server.close === 'function') {
      server.close(() => {
        touchShutdownActivity();
        log('Server closed');
        cleanup();
      });
    } else {
      touchShutdownActivity();
      cleanup();
    }
  } else {
    touchShutdownActivity();
    cleanup();
  }
}

function cleanup() {
  if (_shutdownDone) return;
  _shutdownDone = true;
  clearShutdownWatchdog();

  // Remove PID file
  if (PID_FILE) {
    try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
  clearRuntime();
  log('Daemon stopped');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
  log(err.stack || '');
  // Don't crash — daemon should be resilient
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`);
});

start();
