'use strict';

/**
 * Plugin Loader — discovers, validates, and activates khy plugins.
 *
 * Discovery sources (priority high → low):
 *   1. User config:     ~/.khyquant/config.json (legacy ~/.khy/config.json also supported)
 *   2. Local workspace: ./node_modules/khy-<name> or ./@scope/khy-<name>
 *   3. Global npm:      npm -g prefix/lib/node_modules/khy-*
 *   4. Plugin dir:      ~/.khyquant/plugins/<name>/ (legacy ~/.khy/plugins also supported)
 *   5. Environment:     KHY_PLUGINS=khyquant,khy-notes
 *
 * Each plugin must export a KhyPlugin-compatible object and have a valid
 * package.json#khy manifest field.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { validateManifest } = require('@khy/plugin-sdk');
const { getDataHome } = require('../utils/dataHome');

// Semver comparison — minimal implementation to avoid extra dependency
const semver = {
  satisfies(version, range) {
    try {
      // Parse version
      const [major, minor, patch] = version.split('.').map(Number);
      // Parse range like ">=1.0.0" or ">=1.0.0 <2.0.0"
      const parts = range.split(/\s+/);
      for (const part of parts) {
        const match = part.match(/^([><=!]+)?(\d+)\.(\d+)\.(\d+)$/);
        if (!match) continue;
        const [, op, rMajor, rMinor, rPatch] = match;
        const rv = [+rMajor, +rMinor, +rPatch];
        const cv = [major, minor, patch];
        const cmp = cv[0] - rv[0] || cv[1] - rv[1] || cv[2] - rv[2];
        switch (op) {
          case '>=': if (cmp < 0) return false; break;
          case '>':  if (cmp <= 0) return false; break;
          case '<=': if (cmp > 0) return false; break;
          case '<':  if (cmp >= 0) return false; break;
          case '=':
          case '==': if (cmp !== 0) return false; break;
          default: break;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
};

// ── Constants ─────────────────────────────────────────────────────────────────

const KHY_HOME = getDataHome();
const LEGACY_KHY_HOME = path.join(os.homedir(), '.khy');
const KHY_CONFIG = path.join(KHY_HOME, 'config.json');
const KHY_PLUGINS_DIR = path.join(KHY_HOME, 'plugins');
const LEGACY_KHY_CONFIG = path.join(LEGACY_KHY_HOME, 'config.json');
const LEGACY_KHY_PLUGINS_DIR = path.join(LEGACY_KHY_HOME, 'plugins');
const ACTIVATE_TIMEOUT_MS = 5000;

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, LoadedPlugin>} namespace → loaded plugin */
const _loadedPlugins = new Map();

/** @type {string} Host version (set by init) */
let _hostVersion = '1.0.0';

/**
 * @typedef {object} LoadedPlugin
 * @property {string} namespace
 * @property {object} manifest
 * @property {object} instance - The KhyPlugin object
 * @property {string} state - PluginState
 * @property {string} source - Discovery source
 * @property {string} path - Absolute path to plugin package
 * @property {Array} disposables - Registered disposables for cleanup
 */

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialize the plugin loader.
 *
 * @param {object} opts
 * @param {string} opts.hostVersion - Current khy version
 * @param {object} opts.contextFactory - Function(manifest) → PluginContext
 * @param {object} [opts.logger] - Logger instance
 * @returns {Promise<Map<string, LoadedPlugin>>}
 */
async function init({ hostVersion, contextFactory, logger }) {
  _hostVersion = hostVersion;
  const log = logger || console;

  // Discover all candidate plugin paths
  const candidates = discoverPlugins(log);

  // Validate, load, and activate in parallel
  const activationPromises = [];

  for (const candidate of candidates) {
    const { manifestData, pluginPath, source } = candidate;

    // Validate manifest
    const { valid, errors } = validateManifest(manifestData);
    if (!valid) {
      log.warn(`  ⚠ Plugin ${manifestData.name || pluginPath}: invalid manifest — ${errors.join(', ')}`);
      continue;
    }

    // Check namespace collision
    if (_loadedPlugins.has(manifestData.namespace)) {
      const existing = _loadedPlugins.get(manifestData.namespace);
      log.warn(`  ⚠ Plugin ${manifestData.name}: namespace "${manifestData.namespace}" conflicts with ${existing.manifest.name}, skipped`);
      continue;
    }

    // Check host version compatibility
    if (!semver.satisfies(_hostVersion, manifestData.engines.khy)) {
      log.warn(`  ⚠ Plugin ${manifestData.name}@${manifestData.version} requires khy ${manifestData.engines.khy}, current ${_hostVersion}. Skipped.`);
      _loadedPlugins.set(manifestData.namespace, {
        namespace: manifestData.namespace,
        manifest: manifestData,
        instance: null,
        state: 'disabled:incompatible',
        source,
        path: pluginPath,
        disposables: [],
      });
      continue;
    }

    // Reserve namespace
    _loadedPlugins.set(manifestData.namespace, {
      namespace: manifestData.namespace,
      manifest: manifestData,
      instance: null,
      state: 'loading',
      source,
      path: pluginPath,
      disposables: [],
    });

    // Load and activate
    activationPromises.push(
      activatePlugin(manifestData, pluginPath, source, contextFactory, log)
    );
  }

  // Parallel activation with allSettled
  await Promise.allSettled(activationPromises);

  const active = [..._loadedPlugins.values()].filter(p => p.state === 'active');
  if (active.length > 0) {
    log.info(`  ✓ ${active.length} plugin(s) loaded: ${active.map(p => p.manifest.displayName || p.manifest.name).join(', ')}`);
  }

  return _loadedPlugins;
}

/**
 * Deactivate all loaded plugins (graceful shutdown).
 */
async function shutdown() {
  const deactivations = [];
  for (const [, plugin] of _loadedPlugins) {
    if (plugin.state === 'active' && plugin.instance && plugin.instance.deactivate) {
      deactivations.push(
        Promise.resolve().then(() => plugin.instance.deactivate()).catch(() => {})
      );
    }
    // Dispose all registered resources
    for (const d of plugin.disposables) {
      try { d.dispose(); } catch {}
    }
  }
  await Promise.allSettled(deactivations);
  _loadedPlugins.clear();
}

/**
 * Get a loaded plugin by namespace.
 */
function getPlugin(namespace) {
  return _loadedPlugins.get(namespace) || null;
}

/**
 * Get all loaded plugins.
 */
function getAllPlugins() {
  return [..._loadedPlugins.values()];
}

/**
 * Get plugin status summary.
 */
function getStatus() {
  const result = [];
  for (const [ns, plugin] of _loadedPlugins) {
    result.push({
      namespace: ns,
      name: plugin.manifest.name,
      displayName: plugin.manifest.displayName,
      version: plugin.manifest.version,
      state: plugin.state,
      source: plugin.source,
    });
  }
  return result;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Discover plugin candidates from all sources.
 * Returns array of { manifestData, pluginPath, source }
 */
function discoverPlugins(log) {
  const candidates = [];
  const seenNames = new Set();

  // 1. User config explicit list
  const configPlugins = discoverFromConfig(log);
  for (const c of configPlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: 'config' });
    }
  }

  // 2. Local workspace node_modules
  const workspacePlugins = discoverFromWorkspace(log);
  for (const c of workspacePlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: 'workspace' });
    }
  }

  // 3. Global npm
  const globalPlugins = discoverFromGlobal(log);
  for (const c of globalPlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: 'global' });
    }
  }

  // 4. plugin data-home directories scan (includes legacy ~/.khy/plugins)
  const dirPlugins = discoverFromPluginsDir(log);
  for (const c of dirPlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: 'dir' });
    }
  }

  // 5. KHY_PLUGINS environment variable
  const envPlugins = discoverFromEnv(log);
  for (const c of envPlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: 'env' });
    }
  }

  return candidates;
}

function discoverFromConfig(log) {
  try {
    const results = [];
    const seenPaths = new Set();
    const configPaths = [KHY_CONFIG, LEGACY_KHY_CONFIG];

    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!Array.isArray(config.plugins)) continue;

      for (const entry of config.plugins) {
        const pluginPath = typeof entry === 'string' ? entry : entry.path;
        if (!pluginPath) continue;

        const resolved = path.isAbsolute(pluginPath) ? pluginPath : path.resolve(pluginPath);
        if (seenPaths.has(resolved)) continue;
        seenPaths.add(resolved);

        const manifest = readManifest(resolved);
        if (manifest) results.push({ manifestData: manifest, pluginPath: resolved });
      }
    }

    return results;
  } catch {
    return [];
  }
}

function discoverFromWorkspace(log) {
  const results = [];
  const seenPaths = new Set();
  const roots = new Set([
    process.cwd(),
    path.resolve(__dirname, '../../../'),   // backend/
    path.resolve(__dirname, '../../../../'),// workspace root
  ]);

  if (process.env.KHYQUANT_ROOT) {
    roots.add(path.resolve(process.env.KHYQUANT_ROOT));
  }

  for (const root of roots) {
    const nmDir = path.join(root, 'node_modules');
    if (!fs.existsSync(nmDir)) continue;

    try {
      // Scan top-level for khy-* packages
      const entries = fs.readdirSync(nmDir);
      for (const entry of entries) {
        if (entry.startsWith('khy-')) {
          const pluginPath = path.join(nmDir, entry);
          if (!seenPaths.has(pluginPath)) {
            seenPaths.add(pluginPath);
            const manifest = readManifest(pluginPath);
            if (manifest) results.push({ manifestData: manifest, pluginPath });
          }
        }
        // Scan @scope/khy-* packages
        if (entry.startsWith('@')) {
          const scopeDir = path.join(nmDir, entry);
          try {
            const scopedEntries = fs.readdirSync(scopeDir);
            for (const scoped of scopedEntries) {
              if (!scoped.startsWith('khy-')) continue;
              const pluginPath = path.join(scopeDir, scoped);
              if (seenPaths.has(pluginPath)) continue;
              seenPaths.add(pluginPath);
              const manifest = readManifest(pluginPath);
              if (manifest) results.push({ manifestData: manifest, pluginPath });
            }
          } catch {}
        }
      }
    } catch {}
  }

  return results;
}

function discoverFromGlobal(log) {
  const results = [];
  try {
    // Get global npm prefix
    const { execSync } = require('child_process');
    const prefix = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 3000 }).trim();
    const globalNm = process.platform === 'win32'
      ? path.join(prefix, 'node_modules')
      : path.join(prefix, 'lib', 'node_modules');
    if (!fs.existsSync(globalNm)) return results;

    const entries = fs.readdirSync(globalNm);
    for (const entry of entries) {
      if (entry.startsWith('khy-') && entry !== 'khy') {
        const pluginPath = path.join(globalNm, entry);
        const manifest = readManifest(pluginPath);
        if (manifest) results.push({ manifestData: manifest, pluginPath });
      }
    }
  } catch {}
  return results;
}

function discoverFromPluginsDir(log) {
  const results = [];

  for (const dir of [KHY_PLUGINS_DIR, LEGACY_KHY_PLUGINS_DIR]) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pluginPath = path.join(dir, entry.name);
        const manifest = readManifest(pluginPath);
        if (manifest) results.push({ manifestData: manifest, pluginPath });
      }
    } catch {}
  }

  return results;
}

function discoverFromEnv(log) {
  const results = [];
  const envVal = process.env.KHY_PLUGINS;
  if (!envVal) return results;

  const names = envVal.split(',').map(s => s.trim()).filter(Boolean);
  for (const name of names) {
    // Try to find it via require.resolve
    try {
      const pkgJsonPath = require.resolve(`${name}/package.json`);
      const pluginPath = path.dirname(pkgJsonPath);
      const manifest = readManifest(pluginPath);
      if (manifest) results.push({ manifestData: manifest, pluginPath });
    } catch {}
  }
  return results;
}

// ── Manifest Reading ──────────────────────────────────────────────────────────

/**
 * Read and parse the khy manifest from a plugin directory.
 * Returns null if no valid khy manifest found.
 */
function readManifest(pluginPath) {
  try {
    const pkgJsonPath = path.join(pluginPath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return null;

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    if (!pkg.khy) return null;

    // Merge top-level fields into manifest
    return {
      name: pkg.name,
      version: pkg.version,
      ...pkg.khy,
    };
  } catch {
    return null;
  }
}

// ── Activation ────────────────────────────────────────────────────────────────

/**
 * Load and activate a single plugin with timeout.
 */
async function activatePlugin(manifestData, pluginPath, source, contextFactory, log) {
  const entry = _loadedPlugins.get(manifestData.namespace);
  if (!entry) return;

  try {
    // Resolve entry file
    const mainPath = path.resolve(pluginPath, manifestData.main);
    if (!fs.existsSync(mainPath)) {
      throw new Error(`Entry file not found: ${manifestData.main}`);
    }

    // Load the plugin module
    const pluginModule = require(mainPath);
    const instance = pluginModule.default || pluginModule;

    if (typeof instance.activate !== 'function') {
      throw new Error('Plugin does not export an activate() function');
    }

    // Create context
    const ctx = contextFactory(manifestData, entry);

    // Activate with timeout, and always clear the timer to avoid open handles.
    let activationTimer = null;
    try {
      await Promise.race([
        Promise.resolve(instance.activate(ctx)),
        new Promise((_, reject) => {
          activationTimer = setTimeout(
            () => reject(new Error('Activation timeout (5s)')),
            ACTIVATE_TIMEOUT_MS
          );
          if (activationTimer.unref) activationTimer.unref();
        }),
      ]);
    } finally {
      if (activationTimer) clearTimeout(activationTimer);
    }

    // Store instance and mark active
    entry.instance = instance;
    entry.state = 'active';
  } catch (err) {
    const errorType = err.message.includes('timeout') ? 'disabled:timeout' : 'disabled:error';
    entry.state = errorType;
    log.warn(`  ⚠ Plugin ${manifestData.name}: ${err.message}`);
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  init,
  shutdown,
  getPlugin,
  getAllPlugins,
  getStatus,
  discoverPlugins,
  readManifest,
  KHY_HOME,
  KHY_PLUGINS_DIR,
};
