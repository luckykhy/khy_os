/**
 * TLS Sidecar Manager — spawn/stop/health check for the Go uTLS proxy.
 *
 * The sidecar runs as a subprocess on 127.0.0.1:<port>, simulating browser
 * TLS fingerprints to bypass Cloudflare and similar bot-detection services.
 *
 * Usage:
 *   const sidecar = require('./tlsSidecar');
 *   await sidecar.start();
 *   const proxyUrl = sidecar.getProxyUrl();  // http://127.0.0.1:9150
 *   await sidecar.stop();
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const installer = require('./installer');
// 数据家单一真源:复用主 backend 的 getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../../../utils/dataHome。
const { getAppDataDir } = require('../../../utils/dataHome');

const CONFIG_PATH = getAppDataDir('tls_sidecar.json');

const DEFAULT_CONFIG = {
  enabled: false,
  port: 9150,
  fingerprint: 'chrome_auto',
  targets: ['api.anthropic.com', 'api.x.ai', 'generativelanguage.googleapis.com'],
};

let _process = null;
let _config = null;

/**
 * Load configuration from disk or env.
 */
function loadConfig() {
  if (_config) return _config;

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    } else {
      _config = { ...DEFAULT_CONFIG };
    }
  } catch {
    _config = { ...DEFAULT_CONFIG };
  }

  // Environment overrides
  if (process.env.TLS_SIDECAR_ENABLED !== undefined) _config.enabled = process.env.TLS_SIDECAR_ENABLED === 'true';
  if (process.env.TLS_SIDECAR_PORT) _config.port = parseInt(process.env.TLS_SIDECAR_PORT, 10);
  if (process.env.TLS_SIDECAR_FINGERPRINT) _config.fingerprint = process.env.TLS_SIDECAR_FINGERPRINT;
  if (process.env.TLS_SIDECAR_TARGETS) _config.targets = process.env.TLS_SIDECAR_TARGETS.split(',').map(s => s.trim());

  return _config;
}

/**
 * Save configuration to disk.
 */
function saveConfig(config) {
  _config = { ...DEFAULT_CONFIG, ...config };
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2));
}

/**
 * Start the TLS sidecar process.
 */
async function start(options = {}) {
  if (_process) throw new Error('TLS Sidecar already running');

  const config = loadConfig();
  const port = options.port || config.port;
  const fingerprint = options.fingerprint || config.fingerprint;

  // Ensure binary is available
  const installResult = installer.install();
  if (!installResult.success) {
    throw new Error(`TLS Sidecar binary not available: ${installResult.error}`);
  }

  const binaryPath = installer.getBinaryPath();

  return new Promise((resolve, reject) => {
    const args = [
      `-port`, String(port),
      `-fingerprint`, fingerprint,
    ];

    _process = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        reject(new Error('TLS Sidecar startup timeout'));
        stop();
      }
    }, 10000);

    _process.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('starting on') && !started) {
        started = true;
        clearTimeout(timeout);
        config.port = port;
        config.fingerprint = fingerprint;
        config.enabled = true;
        saveConfig(config);
        resolve({ port, fingerprint, pid: _process.pid });
      }
    });

    _process.stderr.on('data', (data) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`TLS Sidecar error: ${data.toString().trim()}`));
      }
    });

    _process.on('exit', (code) => {
      _process = null;
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`TLS Sidecar exited with code ${code}`));
      }
    });

    _process.on('error', (err) => {
      _process = null;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Stop the sidecar process.
 */
async function stop() {
  if (!_process) return;
  _process.kill('SIGTERM');
  await new Promise(resolve => {
    const t = setTimeout(() => { if (_process) _process.kill('SIGKILL'); resolve(); }, 3000);
    if (_process) _process.on('exit', () => { clearTimeout(t); resolve(); });
    else { clearTimeout(t); resolve(); }
  });
  _process = null;
}

/**
 * Check health by attempting TCP connection to sidecar port.
 */
function health() {
  return new Promise((resolve) => {
    const config = loadConfig();
    const req = http.get(`http://127.0.0.1:${config.port}/__health`, { timeout: 2000 }, (res) => {
      resolve({ alive: true, port: config.port });
    });
    req.on('error', () => resolve({ alive: false, port: config.port }));
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, port: config.port }); });
  });
}

/**
 * Check if sidecar is running.
 */
function isRunning() {
  return _process !== null;
}

/**
 * Get the proxy URL for HTTP clients.
 */
function getProxyUrl() {
  const config = loadConfig();
  return `http://127.0.0.1:${config.port}`;
}

/**
 * Check if a given hostname should use the TLS sidecar.
 */
function shouldProxy(hostname) {
  const config = loadConfig();
  if (!config.enabled || !isRunning()) return false;
  return config.targets.some(t => hostname === t || hostname.endsWith('.' + t));
}

/**
 * Resolve the "去哪下载" descriptor for the sidecar binary, gated by the same
 * master switch as the mihomo core hint (KHY_PROXY_CORE_DOWNLOAD_HINT). Returns
 * null when the gate is off or on any error — byte-for-byte revert of getStatus.
 *
 * ai-backend has no flagRegistry, so we replicate its default-on semantics
 * inline: enabled unless the env value is one of the canonical off-words.
 */
function _sidecarDownload() {
  try {
    const raw = process.env.KHY_PROXY_CORE_DOWNLOAD_HINT;
    const OFF = ['0', 'false', 'off', 'no'];
    if (raw != null && OFF.includes(String(raw).trim().toLowerCase())) return null;
    return installer.describeSidecarDownload();
  } catch {
    return null;
  }
}

/**
 * Get current status.
 */
function getStatus() {
  const config = loadConfig();
  return {
    running: isRunning(),
    enabled: config.enabled,
    port: config.port,
    fingerprint: config.fingerprint,
    targets: config.targets,
    pid: _process?.pid || null,
    binaryInstalled: installer.isInstalled(),
    goAvailable: installer.hasGo(),
    download: _sidecarDownload(),
  };
}

/**
 * Set fingerprint at runtime.
 */
async function setFingerprint(name) {
  const config = loadConfig();
  config.fingerprint = name;
  saveConfig(config);
  // Restart if running
  if (isRunning()) {
    await stop();
    await start({ fingerprint: name });
  }
}

module.exports = {
  start,
  stop,
  health,
  isRunning,
  getProxyUrl,
  shouldProxy,
  getStatus,
  setFingerprint,
  loadConfig,
  saveConfig,
};
