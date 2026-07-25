'use strict';

/**
 * Multi-Terminal Agent Backend — manage sub-agents across multiple terminal sessions.
 *
 * Supports:
 *   - tmux: Create named sessions with split panes per agent
 *   - iTerm2: AppleScript-based tab/pane creation (macOS)
 *   - In-process: Default fallback using child_process (existing behavior)
 *
 * Architecture:
 *   Each sub-agent gets its own terminal pane/tab for:
 *     - Independent stdout/stderr streams
 *     - Visual monitoring of parallel agent work
 *     - Interactive debugging when needed
 *
 * @module multiTerminalBackend
 */

const { spawn, execSync } = require('child_process');
const os = require('os');
const path = require('path');
const log = require('../utils/logger');
const { searchExecutable, safeKill } = require('../tools/platformUtils');

// ── Backend Detection ──

/**
 * Detect available terminal backends.
 * @returns {{tmux: boolean, iterm2: boolean, inProcess: boolean}}
 */
function detectBackends() {
  return {
    tmux: _isAvailable('tmux'),
    iterm2: os.platform() === 'darwin' && _isAvailable('osascript'),
    inProcess: true,
  };
}

/**
 * Get the best available backend.
 * @param {string} [preferred] - 'tmux' | 'iterm2' | 'inProcess'
 * @returns {string}
 */
function selectBackend(preferred) {
  const available = detectBackends();
  if (preferred && available[preferred]) return preferred;
  if (available.tmux) return 'tmux';
  if (available.iterm2) return 'iterm2';
  return 'inProcess';
}

// ── Tmux Backend ──

const TMUX_SESSION_PREFIX = 'khy-agent';

/**
 * Tmux session manager for sub-agents.
 */
class TmuxBackend {
  constructor(options) {
    this._sessionName = (options && options.sessionName) || `${TMUX_SESSION_PREFIX}-${Date.now()}`;
    this._panes = new Map(); // agentId → paneId
    this._initialized = false;
  }

  get sessionName() { return this._sessionName; }

  /**
   * Initialize the tmux session.
   */
  async init() {
    if (this._initialized) return;
    if (process.platform === 'win32') {
      throw new Error('TmuxBackend is not supported on Windows — use inProcess backend');
    }

    try {
      // Check if session already exists
      execSync(`tmux has-session -t "${this._sessionName}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Create new session (detached)
      execSync(`tmux new-session -d -s "${this._sessionName}" -x 200 -y 50`, { stdio: 'pipe' });
    }

    this._initialized = true;
    log.info(`Tmux session "${this._sessionName}" ready`);
  }

  /**
   * Spawn a sub-agent in a new tmux pane.
   *
   * @param {string} agentId - Unique agent identifier
   * @param {string} command - Command to run
   * @param {string[]} [args] - Command arguments
   * @param {object} [options]
   * @param {string} [options.cwd] - Working directory
   * @param {string} [options.title] - Pane title
   * @param {'horizontal'|'vertical'} [options.split] - Split direction
   * @returns {{paneId: string, agentId: string}}
   */
  async spawnAgent(agentId, command, args, options) {
    const opts = options || {};
    await this.init();

    const fullCommand = [command, ...(args || [])].join(' ');
    const split = opts.split || 'vertical';
    const splitFlag = split === 'horizontal' ? '-h' : '-v';

    let paneId;
    if (this._panes.size === 0) {
      // Use the initial pane
      execSync(`tmux send-keys -t "${this._sessionName}" "${_escapeShell(fullCommand)}" Enter`, { stdio: 'pipe' });
      const output = execSync(`tmux list-panes -t "${this._sessionName}" -F "#{pane_id}"`, { stdio: 'pipe' }).toString().trim();
      paneId = output.split('\n')[0];
    } else {
      // Split and run in new pane
      const splitOutput = execSync(
        `tmux split-window ${splitFlag} -t "${this._sessionName}" -P -F "#{pane_id}" "${_escapeShell(fullCommand)}"`,
        { cwd: opts.cwd, stdio: 'pipe' }
      ).toString().trim();
      paneId = splitOutput;

      // Re-balance layout
      try {
        execSync(`tmux select-layout -t "${this._sessionName}" tiled`, { stdio: 'pipe' });
      } catch { /* ignore */ }
    }

    // Set pane title
    if (opts.title || agentId) {
      try {
        execSync(`tmux select-pane -t "${paneId}" -T "${opts.title || agentId}"`, { stdio: 'pipe' });
      } catch { /* older tmux versions may not support -T */ }
    }

    this._panes.set(agentId, paneId);
    log.info(`Agent "${agentId}" spawned in tmux pane ${paneId}`);

    return { paneId, agentId };
  }

  /**
   * Send input to an agent's pane.
   */
  sendKeys(agentId, keys) {
    const paneId = this._panes.get(agentId);
    if (!paneId) throw new Error(`Agent "${agentId}" not found`);
    execSync(`tmux send-keys -t "${paneId}" "${_escapeShell(keys)}" Enter`, { stdio: 'pipe' });
  }

  /**
   * Capture output from an agent's pane.
   * @param {string} agentId
   * @param {number} [lines] - Number of lines to capture (default: 50)
   * @returns {string}
   */
  captureOutput(agentId, lines) {
    const paneId = this._panes.get(agentId);
    if (!paneId) throw new Error(`Agent "${agentId}" not found`);
    return execSync(`tmux capture-pane -t "${paneId}" -p -S -${lines || 50}`, { stdio: 'pipe' }).toString();
  }

  /**
   * Kill a specific agent's pane.
   */
  killAgent(agentId) {
    const paneId = this._panes.get(agentId);
    if (!paneId) return;

    try {
      execSync(`tmux kill-pane -t "${paneId}"`, { stdio: 'pipe' });
    } catch { /* already dead */ }

    this._panes.delete(agentId);
  }

  /**
   * List all active agent panes.
   * @returns {Array<{agentId: string, paneId: string}>}
   */
  listAgents() {
    return [...this._panes.entries()].map(([agentId, paneId]) => ({ agentId, paneId }));
  }

  /**
   * Attach to the tmux session (interactive).
   */
  attach() {
    spawn('tmux', ['attach-session', '-t', this._sessionName], { stdio: 'inherit' });
  }

  /**
   * Destroy the entire tmux session.
   */
  destroy() {
    try {
      execSync(`tmux kill-session -t "${this._sessionName}"`, { stdio: 'pipe' });
    } catch { /* already dead */ }
    this._panes.clear();
    this._initialized = false;
  }
}

// ── iTerm2 Backend ──

class ITermBackend {
  constructor() {
    this._tabs = new Map(); // agentId → tabIndex
  }

  /**
   * Spawn a sub-agent in a new iTerm2 tab.
   */
  async spawnAgent(agentId, command, args, options) {
    const opts = options || {};
    const fullCommand = [command, ...(args || [])].join(' ');
    const cwd = opts.cwd || process.cwd();

    const script = `
      tell application "iTerm2"
        tell current window
          create tab with default profile
          tell current session of current tab
            write text "cd ${_escapeAppleScript(cwd)} && ${_escapeAppleScript(fullCommand)}"
            set name to "${_escapeAppleScript(opts.title || agentId)}"
          end tell
        end tell
      end tell
    `;

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
      this._tabs.set(agentId, this._tabs.size);
      log.info(`Agent "${agentId}" spawned in iTerm2 tab`);
      return { agentId, tabIndex: this._tabs.get(agentId) };
    } catch (err) {
      throw new Error(`iTerm2 spawn failed: ${err.message}`);
    }
  }

  /**
   * Send input to an agent's tab.
   */
  sendKeys(agentId, keys) {
    const script = `
      tell application "iTerm2"
        tell current window
          tell current session of tab ${(this._tabs.get(agentId) || 0) + 1}
            write text "${_escapeAppleScript(keys)}"
          end tell
        end tell
      end tell
    `;
    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    } catch { /* ignore */ }
  }

  listAgents() {
    return [...this._tabs.entries()].map(([agentId, tabIndex]) => ({ agentId, tabIndex }));
  }

  killAgent(agentId) {
    const script = `
      tell application "iTerm2"
        tell current window
          close tab ${(this._tabs.get(agentId) || 0) + 1}
        end tell
      end tell
    `;
    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' });
    } catch { /* ignore */ }
    this._tabs.delete(agentId);
  }

  destroy() {
    for (const agentId of this._tabs.keys()) {
      this.killAgent(agentId);
    }
  }
}

// ── In-Process Backend (fallback) ──

class InProcessBackend {
  constructor() {
    this._processes = new Map(); // agentId → child process
  }

  async spawnAgent(agentId, command, args, options) {
    const opts = options || {};
    const child = spawn(command, args || [], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, KHY_AGENT_ID: agentId },
    });

    this._processes.set(agentId, child);
    log.info(`Agent "${agentId}" spawned in-process (PID: ${child.pid})`);

    return { agentId, pid: child.pid };
  }

  sendKeys(agentId, input) {
    const child = this._processes.get(agentId);
    if (child && child.stdin.writable) {
      child.stdin.write(input + '\n');
    }
  }

  captureOutput(agentId) {
    // Not directly supported for in-process; callers should listen to stdout
    return '';
  }

  getProcess(agentId) {
    return this._processes.get(agentId) || null;
  }

  killAgent(agentId) {
    const child = this._processes.get(agentId);
    if (child) {
      safeKill(child, 'SIGTERM', 3000);
    }
    this._processes.delete(agentId);
  }

  listAgents() {
    return [...this._processes.entries()].map(([agentId, child]) => ({
      agentId,
      pid: child.pid,
      alive: !child.killed,
    }));
  }

  destroy() {
    for (const agentId of this._processes.keys()) {
      this.killAgent(agentId);
    }
  }
}

// ── Factory ──

/**
 * Create a terminal backend.
 * @param {string} [type] - 'tmux' | 'iterm2' | 'inProcess' | 'auto'
 * @param {object} [options]
 * @returns {TmuxBackend|ITermBackend|InProcessBackend}
 */
function createBackend(type, options) {
  const resolved = type === 'auto' || !type ? selectBackend() : type;

  switch (resolved) {
    case 'tmux': return new TmuxBackend(options);
    case 'iterm2': return new ITermBackend(options);
    case 'inProcess':
    default: return new InProcessBackend(options);
  }
}

// ── Helpers ──

function _isAvailable(cmd) {
  return !!searchExecutable(cmd);
}

function _escapeShell(str) {
  return str.replace(/["\\$`]/g, '\\$&');
}

function _escapeAppleScript(str) {
  return str.replace(/["\\]/g, '\\$&');
}

module.exports = {
  detectBackends,
  selectBackend,
  createBackend,
  TmuxBackend,
  ITermBackend,
  InProcessBackend,
};
