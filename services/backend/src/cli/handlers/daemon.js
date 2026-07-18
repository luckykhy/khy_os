'use strict';

/**
 * CLI handler for daemon management commands.
 *
 * Usage:
 *   /daemon start [--port 9090]
 *   /daemon stop
 *   /daemon status
 *   /daemon restart
 *   /daemon logs
 *   /daemon sessions
 */

const dm = require('../../services/daemonManager');
const sp = require('../../services/sessionPersistence');
const { foldOutput } = require('../toolDisplayPolicy');

/**
 * Handle daemon subcommands.
 * @param {string} input - Subcommand and args
 * @param {object} deps
 * @param {object} deps.chalk
 * @param {object} [deps.options]
 */
async function handleDaemon(input, deps) {
  const { chalk: c } = deps;
  const options = deps.options || {};
  const args = String(input || '').trim().split(/\s+/);
  const sub = (args[0] || 'status').toLowerCase();

  switch (sub) {
    case 'start':
      return _start(c, options);
    case 'stop':
      return _stop(c);
    case 'status':
      return _status(c);
    case 'restart':
      return _restart(c, options);
    case 'logs':
      return _logs(c);
    case 'sessions':
      return _sessions(c);
    default:
      _help(c);
  }
}

const _sleep = require('../../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)

async function _resolveStartedDaemon(result, options = {}) {
  const attempts = Number.isInteger(options.attempts) ? options.attempts : 8;
  const delayMs = Number.isInteger(options.delayMs) ? options.delayMs : 250;
  let latest = {
    running: true,
    pid: result.pid,
    port: result.port,
    uptime: null,
    health: null,
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await dm.daemonStatus();
      if (status?.running && Number(status.pid) === Number(result.pid)) {
        latest = status;
        if (status.port !== result.port || status.health) {
          return latest;
        }
      }
    } catch { /* best effort */ }

    if (attempt < attempts) {
      await _sleep(delayMs);
    }
  }

  return latest;
}

function _formatStartMessage(action, requestedPort, status) {
  const confirmedPort = status?.port || requestedPort;
  if (requestedPort && confirmedPort && requestedPort !== confirmedPort) {
    return `  Daemon ${action} (PID ${status.pid}, port ${confirmedPort}; requested ${requestedPort} was occupied)`;
  }
  return `  Daemon ${action} (PID ${status.pid}, port ${confirmedPort})`;
}

async function _start(c, options) {
  try {
    const port = options.port ? parseInt(options.port, 10) : undefined;
    const result = dm.daemonStart({ port });
    const status = await _resolveStartedDaemon(result);
    console.log(c.green(_formatStartMessage('started', result.port, status)));
    console.log(c.dim(`  Logs: ${dm.getLogPath()}`));
  } catch (err) {
    console.log(c.yellow(`  ${err.message}`));
  }
}

function _stop(c) {
  const stopped = dm.daemonStop();
  if (stopped) {
    console.log(c.green('  Daemon stopped'));
  } else {
    console.log(c.yellow('  Daemon is not running'));
  }
}

async function _status(c) {
  const status = await dm.daemonStatus();
  console.log('');
  if (status.running) {
    const upSec = Math.round((status.uptime || 0) / 1000);
    const upStr = upSec < 60 ? `${upSec}s` : `${Math.round(upSec / 60)}m`;
    console.log(c.green(`  Daemon: running`));
    console.log(`  PID:    ${status.pid}`);
    console.log(`  Port:   ${status.port}`);
    console.log(`  Uptime: ${upStr}`);
    if (status.health) {
      console.log(`  Health: ${JSON.stringify(status.health)}`);
    }
  } else {
    console.log(c.dim('  Daemon: not running'));
  }
  console.log('');
}

async function _restart(c, options) {
  try {
    const port = options.port ? parseInt(options.port, 10) : undefined;
    const result = dm.daemonRestart({ port });
    const status = await _resolveStartedDaemon(result);
    console.log(c.green(_formatStartMessage('restarted', result.port, status)));
  } catch (err) {
    console.log(c.red(`  Restart failed: ${err.message}`));
  }
}

function _logs(c) {
  const logPath = dm.getLogPath();
  console.log(c.dim(`  Log file: ${logPath}`));
  try {
    const fs = require('fs');
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const { lines: foldedLines } = foldOutput(lines, { maxLines: 30, foldHead: 0, foldTail: 30 });
    console.log('');
    for (const line of foldedLines) {
      console.log(`  ${c.dim(line)}`);
    }
    console.log('');
  } catch {
    console.log(c.yellow('  No log file found.'));
  }
}

function _sessions(c) {
  const sessions = sp.listPersistedSessions();
  if (sessions.length === 0) {
    console.log(c.dim('  No persisted sessions.'));
    return;
  }
  console.log('');
  console.log(c.bold(`  Persisted Sessions (${sessions.length})`));
  console.log('');
  for (const s of sessions) {
    const date = new Date(s.updatedAt).toLocaleString();
    console.log(`  ${c.cyan(s.sessionId)}  ${s.title}  ${c.dim(date)}  (${s.messageCount} msgs)`);
  }
  console.log('');
}

function _help(c) {
  console.log('');
  console.log(c.bold('  Daemon Management'));
  console.log('');
  console.log(c.dim('    /daemon start [--port 9090]   Start daemon'));
  console.log(c.dim('    /daemon stop                  Stop daemon'));
  console.log(c.dim('    /daemon status                Show daemon status'));
  console.log(c.dim('    /daemon restart               Restart daemon'));
  console.log(c.dim('    /daemon logs                  Show recent log'));
  console.log(c.dim('    /daemon sessions              List persisted sessions'));
  console.log('');
}

module.exports = { handleDaemon };
