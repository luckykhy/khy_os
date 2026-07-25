'use strict';

/**
 * Extension Marketplace Service — search, install, update, and manage extensions
 * from the online registry.
 *
 * Wraps extensionManager with registry discovery, version checking,
 * and scaffolding (new extension template).
 *
 * @module extensionMarketplace
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const log = require('../utils/logger');
const { withTempDir } = require('../utils/ephemeralTmp');

const {
  listExtensions,
  installExtension,
  uninstallExtension,
  setEnabled,
  loadExtension,
  EXTENSIONS_DIR,
} = require('./extensions/extensionManager');

// ── Registry Config ──

const DEFAULT_REGISTRY = 'https://registry.khy.dev';
const REGISTRY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let _registryCache = null;
let _registryCacheTime = 0;

/**
 * Get the registry URL from config or environment.
 * @returns {string}
 */
function _getRegistryUrl() {
  return process.env.KHY_EXTENSION_REGISTRY || DEFAULT_REGISTRY;
}

// ── Registry API ──

/**
 * Search the online registry for extensions.
 * @param {string} [query] - Search query (name, description, tags)
 * @param {object} [options]
 * @param {string[]} [options.tags] - Filter by tags
 * @param {number} [options.limit] - Max results (default 20)
 * @returns {Promise<Array<{name, version, description, author, tags, downloads}>>}
 */
async function search(query, options) {
  const opts = options || {};
  const limit = opts.limit || 20;
  const url = new URL('/v1/extensions', _getRegistryUrl());
  if (query) url.searchParams.set('q', query);
  if (opts.tags && opts.tags.length) url.searchParams.set('tags', opts.tags.join(','));
  url.searchParams.set('limit', String(limit));

  try {
    const data = await _fetchJson(url.toString());
    return (data.extensions || data.results || data || []).slice(0, limit);
  } catch (err) {
    log.debug('Registry search failed:', err.message);
    return [];
  }
}

/**
 * Get extension details from registry.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function getInfo(name) {
  const url = `${_getRegistryUrl()}/v1/extensions/${encodeURIComponent(name)}`;
  try {
    return await _fetchJson(url);
  } catch {
    return null;
  }
}

/**
 * Install an extension from the registry by name.
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.version] - Specific version (default: latest)
 * @returns {Promise<{name, version, path}>}
 */
async function installFromRegistry(name, options) {
  const opts = options || {};
  const info = await getInfo(name);

  if (!info) {
    throw new Error(`Extension "${name}" not found in registry`);
  }

  const version = opts.version || info.latestVersion || info.version;
  const gitUrl = info.repository || info.git;
  const tarballUrl = info.tarball || info.downloadUrl;

  if (tarballUrl) {
    return _installFromTarball(name, tarballUrl, version);
  }

  if (gitUrl) {
    const result = installExtension(gitUrl);
    return { ...result, version };
  }

  throw new Error(`Extension "${name}" has no installable source`);
}

/**
 * Check for updates for all installed extensions.
 * @returns {Promise<Array<{name, currentVersion, latestVersion, updateAvailable}>>}
 */
async function checkUpdates() {
  const installed = listExtensions();
  const results = [];

  for (const ext of installed) {
    try {
      const info = await getInfo(ext.name);
      if (!info) {
        results.push({ name: ext.name, currentVersion: ext.version, latestVersion: null, updateAvailable: false });
        continue;
      }

      const latest = info.latestVersion || info.version || ext.version;
      const updateAvailable = _versionCompare(latest, ext.version) > 0;
      results.push({ name: ext.name, currentVersion: ext.version, latestVersion: latest, updateAvailable });
    } catch {
      results.push({ name: ext.name, currentVersion: ext.version, latestVersion: null, updateAvailable: false });
    }
  }

  return results;
}

/**
 * Update an extension to the latest version.
 * @param {string} name
 * @returns {Promise<{name, oldVersion, newVersion}>}
 */
async function updateExtension(name) {
  const installed = listExtensions().find((e) => e.name === name);
  if (!installed) throw new Error(`Extension "${name}" is not installed`);

  const oldVersion = installed.version;

  // Uninstall and reinstall
  uninstallExtension(name);
  const result = await installFromRegistry(name);

  return { name, oldVersion, newVersion: result.version || 'latest' };
}

/**
 * Create a new extension project from a template.
 * @param {string} name - Extension name
 * @param {string} [targetDir] - Where to create (default: cwd)
 * @param {object} [options]
 * @param {string[]} [options.capabilities] - Capabilities to include
 * @returns {{path: string, files: string[]}}
 */
function scaffold(name, targetDir, options) {
  const opts = options || {};
  const dir = path.resolve(targetDir || process.cwd(), name);

  if (fs.existsSync(dir)) {
    throw new Error(`Directory "${dir}" already exists`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const capabilities = opts.capabilities || ['cli-command'];
  const files = [];

  // openclaw.plugin.json
  const manifest = {
    name,
    version: '0.1.0',
    description: `KHY extension: ${name}`,
    capabilities,
    entry: './src/index.js',
    skills: [],
    mcp: null,
  };
  fs.writeFileSync(path.join(dir, 'openclaw.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
  files.push('openclaw.plugin.json');

  // package.json
  const pkg = {
    name: `khy-ext-${name}`,
    version: '0.1.0',
    description: manifest.description,
    main: 'src/index.js',
    scripts: { test: 'echo "Error: no test specified" && exit 1' },
    keywords: ['khy', 'extension'],
    license: 'GPL-3.0-only',
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  files.push('package.json');

  // src/index.js
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const entryCode = `'use strict';

/**
 * ${name} — KHY Extension
 */

module.exports = {
  /**
   * Called when the extension is activated.
   * @param {object} ctx - Extension context
   */
  activate(ctx) {
    ctx.logger.info('${name} activated');

    ${capabilities.includes('cli-command') ? `// Register a CLI command
    ctx.commands.register('${name}', {
      description: '${name} command',
      async handler(args) {
        return 'Hello from ${name}!';
      },
    });` : '// Add extension logic here'}
  },

  /**
   * Called when the extension is deactivated.
   */
  deactivate() {
    // Cleanup resources
  },
};
`;
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), entryCode);
  files.push('src/index.js');

  return { path: dir, files };
}

/**
 * Link a local directory as an extension (dev mode).
 * @param {string} dir - Local extension directory
 * @returns {{name: string, path: string}}
 */
function link(dir) {
  const absDir = path.resolve(dir);
  return installExtension(absDir);
}

/**
 * Unlink (remove) a linked extension.
 * @param {string} name
 */
function unlink(name) {
  uninstallExtension(name);
}

// ── Extended list with registry info ──

/**
 * List installed extensions with formatted output.
 * @returns {Array}
 */
function list() {
  return listExtensions();
}

/**
 * Enable an extension.
 * @param {string} name
 */
function enable(name) {
  setEnabled(name, true);
}

/**
 * Disable an extension.
 * @param {string} name
 */
function disable(name) {
  setEnabled(name, false);
}

// ── Internal Helpers ──

async function _installFromTarball(name, tarballUrl, version) {
  const dest = path.join(EXTENSIONS_DIR, name);
  if (fs.existsSync(dest)) {
    throw new Error(`Extension "${name}" already installed. Uninstall first.`);
  }

  const { execSync } = require('child_process');
  fs.mkdirSync(dest, { recursive: true });

  try {
    // 下载到一次性临时目录再解压（避免 curl | tar 管道，Windows 不兼容）；
    // withTempDir 保证用完即毁，即便解压抛错或进程崩溃也不留垃圾。
    await withTempDir(async (scratchDir) => {
      const tgzPath = path.join(scratchDir, `${name}.tar.gz`);
      await _downloadFile(tarballUrl, tgzPath);
      execSync(`tar xzf "${tgzPath}" --strip-components=1 -C "${dest}"`, { stdio: 'pipe' });
    }, { prefix: `ext-${name}` });
  } catch (err) {
    // Cleanup on failure
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`Failed to download extension: ${err.message}`);
  }

  // Run npm install if needed
  if (fs.existsSync(path.join(dest, 'package.json'))) {
    try {
      execSync('npm install --production', { cwd: dest, stdio: 'pipe' });
    } catch { /* optional */ }
  }

  return { name, version, path: dest };
}

/**
 * 下载文件到本地路径（跟随重定向）。
 */
function _downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 30_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _downloadFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(resolve));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

function _fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        _fetchJson(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function _versionCompare(a, b) {
  if (!a || !b) return 0;
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

module.exports = {
  search,
  getInfo,
  installFromRegistry,
  checkUpdates,
  updateExtension,
  scaffold,
  link,
  unlink,
  list,
  enable,
  disable,
  install: installExtension,
  uninstall: uninstallExtension,
  load: loadExtension,
};
