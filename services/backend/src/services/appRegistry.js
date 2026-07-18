/**
 * App Registry — manages installable applications on the khy platform.
 *
 * khy acts as a host/base platform. Apps (khyquant, khy-book, khy-tourism, etc.)
 * register themselves here and run as independent sub-processes.
 *
 * Storage: ~/.khyquant/apps/<name>.json (one manifest per app)
 *
 * Lifecycle:
 *   register → start → (running as subprocess) → stop → unregister
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { safeKill } = require('../tools/platformUtils');
const { spawn } = require('child_process');

const APPS_DIR = path.join(os.homedir(), '.khyquant', 'apps');

// In-memory process map: appName → ChildProcess
const _processes = new Map();

// ─── Directory Helpers ────────────────────────────────────────────────────────

function _ensureDir() {
  if (!fs.existsSync(APPS_DIR)) {
    fs.mkdirSync(APPS_DIR, { recursive: true });
  }
}

function _manifestPath(name) {
  return path.join(APPS_DIR, `${name}.json`);
}

// ─── Registry CRUD ───────────────────────────────────────────────────────────

/**
 * Register an app. Writes its manifest to ~/.khyquant/apps/<name>.json.
 * @param {object} manifest - App manifest object
 * @param {string} manifest.name - Unique app name (e.g., "khyquant")
 * @param {string} manifest.version - Semantic version
 * @param {string} manifest.description - Human-readable description
 * @param {string} manifest.entry - Path to the main script (server.js or similar)
 * @param {number} [manifest.port] - Default backend port
 * @param {number} [manifest.frontendPort] - Default frontend port (optional)
 * @param {string} [manifest.source] - Installation source: "pip" | "local" | "git" | "npm"
 * @param {string[]} [manifest.commands] - Command names that trigger this app in REPL
 * @param {boolean} [manifest.autoStart] - Whether to auto-start with khy
 * @param {string} [manifest.runtime] - Runtime type: "node" | "wasm" | "external"
 * @param {object} [manifest.wasm] - Optional WASM metadata
 */
function register(manifest) {
  if (!manifest || !manifest.name) {
    throw new Error('App manifest must have a "name" field');
  }
  if (manifest.runtime !== 'external' && !manifest.entry) {
    throw new Error('App manifest must have an "entry" field (unless runtime is "external")');
  }
  _ensureDir();

  const record = {
    name: manifest.name,
    version: manifest.version || '0.0.0',
    description: manifest.description || '',
    entry: manifest.entry,
    port: manifest.port || 3000,
    frontendPort: manifest.frontendPort || null,
    source: manifest.source || 'local',
    commands: manifest.commands || [manifest.name],
    autoStart: manifest.autoStart || false,
    runtime: manifest.runtime || 'node',
    wasm: manifest.wasm || null,
    installedAt: new Date().toISOString(),
  };

  fs.writeFileSync(_manifestPath(record.name), JSON.stringify(record, null, 2));
  return record;
}

/**
 * Unregister an app. Removes its manifest file.
 * Does NOT stop a running process — call stop() first.
 */
function unregister(name) {
  const mp = _manifestPath(name);
  if (fs.existsSync(mp)) {
    fs.unlinkSync(mp);
    return true;
  }
  return false;
}

/**
 * Get a single app manifest by name.
 * @returns {object|null}
 */
function get(name) {
  const mp = _manifestPath(name);
  try {
    if (fs.existsSync(mp)) {
      return JSON.parse(fs.readFileSync(mp, 'utf-8'));
    }
  } catch { /* corrupted manifest */ }
  return null;
}

/**
 * List all registered apps.
 * @returns {object[]} Array of manifest objects
 */
function list() {
  _ensureDir();
  const apps = [];
  try {
    const files = fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(APPS_DIR, file), 'utf-8');
        apps.push(JSON.parse(content));
      } catch { /* skip corrupted files */ }
    }
  } catch { /* directory read failed */ }
  return apps;
}

/**
 * Find an app by command name (e.g., user types "khyquant" or "quant").
 * @param {string} cmd - Command string the user typed
 * @returns {object|null} Matching app manifest or null
 */
function findByCommand(cmd) {
  const lower = cmd.toLowerCase();
  const apps = list();
  return apps.find(app =>
    app.name === lower || (app.commands && app.commands.includes(lower))
  ) || null;
}

// ─── Process Lifecycle ────────────────────────────────────────────────────────

/**
 * Check if a port is in use.
 * @returns {Promise<boolean>}
 */
function _isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => { server.close(); resolve(false); });
    server.listen(port);
  });
}

/**
 * Start an app as a detached sub-process.
 * @param {string} name - App name
 * @param {object} [options] - Override options
 * @param {number} [options.port] - Override port
 * @returns {Promise<{success: boolean, port?: number, pid?: number, error?: string}>}
 */
async function start(name, options = {}) {
  const app = get(name);
  if (!app) {
    return { success: false, error: `应用 "${name}" 未注册。运行 /app install ${name} 安装` };
  }

  if ((app.runtime || 'node') === 'wasm') {
    return { success: false, error: `应用 "${name}" 是 WASM 组件。请使用 /app run ${name} 执行导出函数` };
  }

  if (app.runtime === 'external') {
    return { success: false, error: `应用 "${name}" 是外部 CLI 工具，通过 subprocess 按需调用，无需启动常驻进程` };
  }

  // Verify entry script exists
  if (!fs.existsSync(app.entry)) {
    return { success: false, error: `入口文件不存在: ${app.entry}` };
  }

  const port = options.port || app.port || 3000;

  // Check if already running (verify via PID file to reduce false positives)
  const running = await _isPortInUse(port);
  if (running) {
    const pidFile = path.join(APPS_DIR, `${name}.pid`);
    let ownProcess = false;
    try {
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) {
          process.kill(pid, 0); // throws if process doesn't exist
          ownProcess = true;
        }
      }
    } catch { /* PID not valid or process dead */ }

    if (ownProcess) {
      return { success: true, port, alreadyRunning: true };
    }
    // Port occupied by another program
    return { success: false, error: `端口 ${port} 已被其他程序占用，请使用 --port 指定其他端口` };
  }

  // Spawn the app as a detached subprocess
  try {
    const child = spawn(process.execPath, [app.entry], {
      cwd: path.dirname(app.entry),
      env: { ...process.env, PORT: String(port), NODE_ENV: 'development' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.unref();
    _processes.set(name, child);

    // Record PID for later management
    const pidFile = path.join(APPS_DIR, `${name}.pid`);
    try { fs.writeFileSync(pidFile, String(child.pid)); } catch { /* best effort */ }

    // Poll for server to bind (up to 10s, checking every 500ms)
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500));
      // Check if process died early
      if (child.exitCode !== null) {
        return { success: false, error: `进程退出 (code ${child.exitCode})，请检查日志` };
      }
      if (await _isPortInUse(port)) {
        return { success: true, port, pid: child.pid };
      }
    }
    return { success: false, error: '服务启动超时(10s)，请检查日志' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Stop an app's sub-process.
 * @param {string} name - App name
 * @returns {{success: boolean, error?: string}}
 */
function stop(name) {
  // Try in-memory process first
  const proc = _processes.get(name);
  if (proc && proc.exitCode === null) {
    safeKill(proc);
    _processes.delete(name);
    _removePidFile(name);
    return { success: true };
  }

  // Fallback: read PID file
  const pidFile = path.join(APPS_DIR, `${name}.pid`);
  try {
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        try { safeKill(pid); } catch { /* already dead */ }
        _removePidFile(name);
        return { success: true };
      }
    }
  } catch { /* ignore */ }

  return { success: false, error: `应用 "${name}" 未在运行` };
}

function _removePidFile(name) {
  const pidFile = path.join(APPS_DIR, `${name}.pid`);
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch { /* ignore */ }
}

/**
 * Get the running status of an app.
 * @param {string} name - App name
 * @returns {Promise<{installed: boolean, running: boolean, port?: number, pid?: number}>}
 */
async function status(name) {
  const app = get(name);
  if (!app) return { installed: false, running: false };

  if ((app.runtime || 'node') === 'wasm') {
    return {
      installed: true,
      running: false,
      port: null,
      pid: null,
      runtime: 'wasm',
    };
  }

  if (app.runtime === 'external') {
    return {
      installed: true,
      running: true,
      port: null,
      pid: null,
      runtime: 'external',
    };
  }

  const port = app.port || 3000;
  const running = await _isPortInUse(port);

  let pid = null;
  const pidFile = path.join(APPS_DIR, `${name}.pid`);
  try {
    if (fs.existsSync(pidFile)) {
      pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      // Verify process still exists
      try { process.kill(pid, 0); } catch { pid = null; }
    }
  } catch { /* ignore */ }

  return { installed: true, running, port, pid, runtime: app.runtime || 'node' };
}

/**
 * Discover khy-* apps installed via pip.
 * Scans pip list output for packages matching khy-* pattern.
 * @returns {Promise<{name: string, version: string}[]>}
 */
async function discover() {
  const { execFileSync } = require('child_process');
  const discovered = [];

  try {
    const pipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
    const output = execFileSync(pipCmd, ['list', '--format=json'], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const packages = JSON.parse(output);
    for (const pkg of packages) {
      if (pkg.name.startsWith('khy-') && pkg.name !== 'khy-quant' && pkg.name !== 'khy-os') {
        discovered.push({ name: pkg.name, version: pkg.version });
      }
    }
  } catch { /* pip not available or failed */ }

  return discovered;
}

/**
 * Auto-register the khyquant app for dev mode (called from bootstrap).
 * Detects if we're in a git clone with backend/server.js present.
 * @param {string} backendDir - Path to the backend directory
 */
function autoRegisterDev(backendDir) {
  const serverJs = path.join(backendDir, 'server.js');
  if (!fs.existsSync(serverJs)) return;

  const existing = get('khyquant');
  // If already registered with the same path, skip
  if (existing && existing.entry === serverJs) return;

  register({
    name: 'khyquant',
    version: require(path.join(backendDir, 'package.json')).version || '0.0.0',
    description: '量化交易系统',
    entry: serverJs,
    port: 3000,
    frontendPort: 8080,
    source: 'local',
    commands: ['khyquant', 'quant'],
    autoStart: false,
  });
}

module.exports = {
  register,
  unregister,
  get,
  list,
  findByCommand,
  start,
  stop,
  status,
  discover,
  autoRegisterDev,
  APPS_DIR,
};
