'use strict';

/**
 * crossLauncher.js — Cross-platform launcher utility.
 *
 * Allows any platform to start any other platform.
 * Used by CLI, Web, Desktop, and Mobile to orchestrate multi-platform startup.
 *
 * @module services/crossPlatform/crossLauncher
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Single source of truth for local dev ports (zero hardcoding — AGENTS.md rule 1).
// crossLauncher.js is the ONLY module that reads these.
const {
  BACKEND_PORT,
  WEB_FRONTEND_PORT,
  MOBILE_FRONTEND_PORT,
} = require('../../constants/serviceDefaults');

// ── Portable root detection ───────────────────────────────────────

function getPortableRoot() {
  const envRoot = process.env.KHY_OS_DIR || process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT;
  if (envRoot) return path.resolve(envRoot);

  // Walk up from this file to find portable root
  let dir = __dirname;
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, 'khy.bat')) || fs.existsSync(path.join(dir, '.portable'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: assume standard layout
  return path.resolve(__dirname, '..', '..', '..');
}

// ── Platform start commands ───────────────────────────────────────

const PLATFORM_COMMANDS = {
  backend: {
    cmd: 'cmd.exe',
    args: ['/c', 'khy.bat', 'server', 'start'],
    cwd: () => getPortableRoot(),
    description: `Backend server (port ${BACKEND_PORT})`,
  },
  cli: {
    cmd: 'cmd.exe',
    args: ['/c', 'khy.bat'],
    cwd: () => getPortableRoot(),
    description: 'Terminal CLI REPL',
  },
  web: {
    cmd: 'cmd.exe',
    args: ['/c', 'cd', '/d', path.join(getPortableRoot(), 'apps', 'ai-frontend'), '&&', 'npm', 'run', 'dev'],
    cwd: () => path.join(getPortableRoot(), 'apps', 'ai-frontend'),
    description: `Web frontend (port ${WEB_FRONTEND_PORT})`,
  },
  desktop: {
    cmd: 'cmd.exe',
    args: ['/c', 'cd', '/d', path.join(getPortableRoot(), 'apps', 'khyos-desktop'), '&&', 'npm', 'run', 'electron:dev'],
    cwd: () => path.join(getPortableRoot(), 'apps', 'khyos-desktop'),
    description: 'Desktop Electron app',
  },
  mobile: {
    cmd: 'cmd.exe',
    args: ['/c', 'cd', '/d', path.join(getPortableRoot(), 'apps', 'khy-mobile'), '&&', 'npm', 'run', 'dev'],
    cwd: () => path.join(getPortableRoot(), 'apps', 'khy-mobile'),
    description: `Mobile dev server (port ${MOBILE_FRONTEND_PORT})`,
  },
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Start a platform from any other platform.
 * @param {string} platform - 'backend' | 'cli' | 'web' | 'desktop' | 'mobile'
 * @param {object} [options]
 * @param {boolean} [options.wait=false] - Wait for process to exit
 * @param {boolean} [options.detached=true] - Run detached (independent)
 * @returns {Promise<{success: boolean, pid?: number, error?: string}>}
 */
function startPlatform(platform, options = {}) {
  const { wait = false, detached = true } = options;
  const config = PLATFORM_COMMANDS[platform];

  if (!config) {
    return Promise.resolve({ success: false, error: `Unknown platform: ${platform}` });
  }

  return new Promise((resolve) => {
    try {
      const cwd = typeof config.cwd === 'function' ? config.cwd() : config.cwd;
      
      if (!fs.existsSync(cwd)) {
        return resolve({ success: false, error: `Directory not found: ${cwd}` });
      }

      const child = spawn(config.cmd, config.args, {
        cwd,
        detached,
        stdio: wait ? 'inherit' : 'ignore',
        windowsHide: true,
        env: { ...process.env },
      });

      if (detached) {
        child.unref();
      }

      if (wait) {
        child.on('exit', (code) => {
          resolve({ success: code === 0, pid: child.pid, error: code !== 0 ? `Exit code: ${code}` : undefined });
        });
        child.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      } else {
        // Give it a moment to start
        setTimeout(() => {
          resolve({ success: true, pid: child.pid });
        }, 500);
      }
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * Start multiple platforms at once.
 * @param {string[]} platforms - Array of platform names
 * @returns {Promise<object[]>}
 */
async function startMultiple(platforms) {
  const results = [];
  for (const platform of platforms) {
    const result = await startPlatform(platform);
    results.push({ platform, ...result });
    // Small delay between starts to avoid port conflicts
    await new Promise(r => setTimeout(r, 1000));
  }
  return results;
}

/**
 * Get the status of all platforms.
 * @returns {object}
 */
function getPlatformStatus() {
  return {
    backend: {
      running: isPortInUse(BACKEND_PORT),
      port: BACKEND_PORT,
      url: `http://localhost:${BACKEND_PORT}`,
    },
    web: {
      running: isPortInUse(WEB_FRONTEND_PORT),
      port: WEB_FRONTEND_PORT,
      url: `http://localhost:${WEB_FRONTEND_PORT}`,
    },
    desktop: {
      running: false, // Would need process enumeration
      note: 'Check Electron window',
    },
    mobile: {
      running: isPortInUse(MOBILE_FRONTEND_PORT),
      port: MOBILE_FRONTEND_PORT,
      url: `http://localhost:${MOBILE_FRONTEND_PORT}`,
    },
  };
}

/**
 * Check if a port is in use.
 * @param {number} port
 * @returns {boolean}
 */
function isPortInUse(port) {
  // Simple check: try to connect
  const net = require('net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

module.exports = {
  startPlatform,
  startMultiple,
  getPlatformStatus,
  getPortableRoot,
  isPortInUse,
};
