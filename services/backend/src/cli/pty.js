/**
 * PTY Mode — full pseudo-terminal support for interactive commands.
 *
 * Provides a /bash command that drops into an interactive shell with:
 *   - Full PTY (pseudo-terminal) — supports sudo, vim, top, etc.
 *   - Raw mode pass-through for proper key handling
 *   - Auto-detect shell from $SHELL or default to /bin/bash
 *   - Exit detection to return to REPL
 *
 * Falls back to basic child_process.spawn if node-pty is unavailable.
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { defaultShell } = require('../tools/platformUtils');

let _nodePty = null;

function _loadNodePty() {
  if (_nodePty !== null) return _nodePty;
  try {
    _nodePty = require('node-pty');
  } catch {
    _nodePty = false;
  }
  return _nodePty;
}

/**
 * Launch an interactive PTY shell session.
 * Returns a Promise that resolves when the shell exits.
 *
 * @param {Object} options
 * @param {string} options.shell - Shell to launch (default: $SHELL or /bin/bash)
 * @param {string} options.cwd - Working directory
 * @param {Object} options.env - Additional environment variables
 */
function launchPtyShell(options = {}) {
  const shell = options.shell || process.env.SHELL || defaultShell();
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...options.env, TERM: process.env.TERM || 'xterm-256color' };

  const pty = _loadNodePty();

  if (pty) {
    return _launchWithNodePty(pty, shell, cwd, env);
  }
  return _launchFallback(shell, cwd, env);
}

function _launchWithNodePty(pty, shell, cwd, env) {
  return new Promise((resolve) => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    const term = pty.spawn(shell, [], { name: 'xterm-256color', cols, rows, cwd, env });

    // Pipe PTY output to stdout
    term.onData((data) => {
      process.stdout.write(data);
    });

    // Enter raw mode for proper key handling
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const restoreStdin = () => {
      process.stdin.removeListener('data', onData);
      process.stdout.removeListener('resize', onResize);
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(wasRaw || false);
      }
      process.stdin.pause();
    };

    // Pipe stdin to PTY
    const onData = (data) => {
      term.write(data);
    };
    process.stdin.on('data', onData);

    // Handle terminal resize
    const onResize = () => {
      term.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    };
    process.stdout.on('resize', onResize);

    // Restore raw mode on unexpected signals to avoid corrupting parent shell
    const onSignal = () => { restoreStdin(); process.exit(130); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    // Cleanup on exit
    term.onExit(({ exitCode }) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      restoreStdin();
      resolve(exitCode);
    });
  });
}

function _launchFallback(shell, cwd, env) {
  return new Promise((resolve) => {
    console.log('[PTY] node-pty not available, using basic shell (no full PTY support)');

    // On Windows, cmd.exe needs /Q (echo off) and /K (remain interactive)
    const isCmd = /\bcmd(\.exe)?$/i.test(shell);
    const args = isCmd ? ['/Q', '/K'] : [];

    const child = spawn(shell, args, {
      cwd,
      env,
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      resolve(code);
    });

    child.on('error', (err) => {
      console.error(`[PTY] Shell error: ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Check if node-pty is available.
 */
function isPtyAvailable() {
  return !!_loadNodePty();
}

module.exports = { launchPtyShell, isPtyAvailable };
