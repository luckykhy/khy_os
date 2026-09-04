'use strict';

/**
 * Plugin Loader — discovers, validates, and activates khy plugins.
 *
 * Discovery sources (priority high → low):
 *   1. User config:     ~/.khyquant/config.json (legacy ~/.khy/config.json also supported)
 *   2. Local workspace: ./node_modules/khy-<name> or ./@scope/khy-<name>
 *   3. Global npm:      npm -g prefix/lib/node_modules/khy-*
 *   4. Extension roots: every root of `services/extensions/extensionRoots` —
 *                       <appRoot>/extensions/ (built-in, ships with the package),
 *                       <appHome>/extensions/, KHY_EXTENSION_PATH. **Deferred**:
 *                       see below.
 *   5. Plugin dir:      ~/.khyquant/plugins/<name>/ (legacy ~/.khy/plugins also supported)
 *   6. Environment:     KHY_PLUGINS=khyquant,khy-notes
 *
 * Each plugin must export a KhyPlugin-compatible object and have a valid
 * manifest (`khy.extension.json` or `package.json#khy` — see [DESIGN-ARCH-069] §3).
 *
 * **Eager vs deferred.** Sources 1/2/3/5/6 name a plugin explicitly (a config
 * entry, a dependency, an env var), so being named IS the intent to load it and
 * they are activated during init(). Source 4 is a *directory scan* of a tree the
 * user may simply have dropped a folder into — activating those at startup would
 * charge every built-in extension's module body into boot time, which is exactly
 * what [DESIGN-ARCH-069] §4 forbids. They are therefore only *indexed* at init
 * (namespace reserved, manifest known, entry NOT required) and activated on first
 * use via activateNamespace(). Turning the KHY_PLUGIN_LAZY_LOAD gate off restores
 * eager activation for them too.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getDataHome } = require('../utils/dataHome');
// 拓展根的单一真源（[DESIGN-ARCH-069]）。此前本加载器有自己的 5 个发现源，其中**没有
// 一个**是仓库的 extensions/ —— 随包分发的内置拓展对它完全不可见。
const extensionRoots = require('../services/domain/extensions/extensions/extensionRoots.js');

// Optional SDK load: fall back to a built-in manifest validator when the
// @khy/plugin-sdk package is missing (fail-soft, warn only once).
let _sdkLoadWarned = false;
let validateManifest;
try {
  ({ validateManifest } = require('@khy/plugin-sdk'));
} catch (err) {
  if (!_sdkLoadWarned) {
    _sdkLoadWarned = true;
    console.warn(
      `plugin-loader 加载 @khy/plugin-sdk 失败，改用内置回退校验器（manifest 必填字段校验）: ${err && err.message ? err.message : err}`
    );
  }
  // Fallback validator: mirrors the SDK return shape { valid, errors }.
  // Checks the fields actually consumed by init(): name, namespace,
  // engines.khy, main.
  validateManifest = function validateManifestFallback(manifest) {
    const errors = [];
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['manifest must be an object'] };
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
      errors.push('missing required field: name');
    }
    if (!manifest.namespace || typeof manifest.namespace !== 'string') {
      errors.push('missing required field: namespace');
    }
    if (!manifest.engines || typeof manifest.engines.khy !== 'string') {
      errors.push('missing required field: engines.khy');
    }
    if (!manifest.main || typeof manifest.main !== 'string') {
      errors.push('missing required field: main');
    }
    return { valid: errors.length === 0, errors };
  };
}

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
        if (!match) {
          continue;
        }
        const [, op, rMajor, rMinor, rPatch] = match;
        const rv = [+rMajor, +rMinor, +rPatch];
        const cv = [major, minor, patch];
        const cmp = cv[0] - rv[0] || cv[1] - rv[1] || cv[2] - rv[2];
        switch (op) {
          case '>=':
            if (cmp < 0) {
              return false;
            }
            break;
          case '>':
            if (cmp <= 0) {
              return false;
            }
            break;
          case '<=':
            if (cmp > 0) {
              return false;
            }
            break;
          case '<':
            if (cmp >= 0) {
              return false;
            }
            break;
          case '=':
          case '==':
            if (cmp !== 0) {
              return false;
            }
            break;
          default:
            break;
        }
      }
      return true;
    } catch {
      return false;
    }
  },
};

// ── Constants ─────────────────────────────────────────────────────────────────

const KHY_HOME = getDataHome();
const LEGACY_KHY_HOME = path.join(os.homedir(), '.khy');
const KHY_CONFIG = path.join(KHY_HOME, 'config.json');
const KHY_PLUGINS_DIR = path.join(KHY_HOME, 'plugins');
const LEGACY_KHY_CONFIG = path.join(LEGACY_KHY_HOME, 'config.json');
const LEGACY_KHY_PLUGINS_DIR = path.join(LEGACY_KHY_HOME, 'plugins');
const ACTIVATE_TIMEOUT_MS = 5000;

// 已发现但尚未激活。与 'disabled:*' 有本质区别：那些是**试过并失败**，这个是**还没试**。
const STATE_DISCOVERED = 'discovered:lazy';

// 惰性总闸沿用既有声明式门（default-on），不新立一个。注册表不可用 → 保持默认开。
function _lazyGateOn() {
  try {
    return require('../services/flagRegistry').isFlagEnabled('KHY_PLUGIN_LAZY_LOAD', process.env);
  } catch {
    return true;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, LoadedPlugin>} namespace → loaded plugin */
const _loadedPlugins = new Map();

/** @type {string} Host version (set by init) */
let _hostVersion = '1.0.0';

/** @type {Function|null} contextFactory kept from init(), for deferred activation */
let _contextFactory = null;

/** @type {object|null} logger kept from init(), for deferred activation */
let _logger = null;

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
  // 留存供 activateNamespace() 用：惰性候选在 init 之后才被激活，那时调用方手里
  // 通常已经没有 contextFactory 了（它是 replSession 启动期的局部量）。
  _contextFactory = contextFactory;
  _logger = log;

  // Discover all candidate plugin paths
  const candidates = discoverPlugins(log);

  // Validate, load, and activate in parallel
  const activationPromises = [];

  for (const candidate of candidates) {
    const { manifestData, pluginPath, source } = candidate;

    // Validate manifest
    const { valid, errors } = validateManifest(manifestData);
    if (!valid) {
      log.warn(
        `  ⚠ Plugin ${manifestData.name || pluginPath}: invalid manifest — ${errors.join(', ')}`
      );
      continue;
    }

    // Check namespace collision
    if (_loadedPlugins.has(manifestData.namespace)) {
      const existing = _loadedPlugins.get(manifestData.namespace);
      log.warn(
        `  ⚠ Plugin ${manifestData.name}: namespace "${manifestData.namespace}" conflicts with ${existing.manifest.name}, skipped`
      );
      continue;
    }

    // Check host version compatibility
    if (!semver.satisfies(_hostVersion, manifestData.engines.khy)) {
      log.warn(
        `  ⚠ Plugin ${manifestData.name}@${manifestData.version} requires khy ${manifestData.engines.khy}, current ${_hostVersion}. Skipped.`
      );
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

    // 惰性候选（目录扫描来的）：只占名、不 require 入口。首次调用其贡献名时由
    // activateNamespace() 激活。门控关掉 → 退回即时激活（与其他源同构）。
    const deferred = candidate.lazy && _lazyGateOn();

    // Reserve namespace
    _loadedPlugins.set(manifestData.namespace, {
      namespace: manifestData.namespace,
      manifest: manifestData,
      instance: null,
      state: deferred ? STATE_DISCOVERED : 'loading',
      source,
      path: pluginPath,
      disposables: [],
    });

    if (deferred) {
      continue;
    }

    // Load and activate
    activationPromises.push(activatePlugin(manifestData, pluginPath, source, contextFactory, log));
  }

  // Parallel activation with allSettled
  await Promise.allSettled(activationPromises);

  const active = [..._loadedPlugins.values()].filter((p) => p.state === 'active');
  if (active.length > 0) {
    log.info(
      `  ✓ ${active.length} plugin(s) loaded: ${active.map((p) => p.manifest.displayName || p.manifest.name).join(', ')}`
    );
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
        Promise.resolve()
          .then(() => plugin.instance.deactivate())
          .catch(() => {})
      );
    }
    // Dispose all registered resources
    for (const d of plugin.disposables) {
      try {
        d.dispose();
      } catch {}
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
 * 按需激活一个**已发现但未激活**的拓展（[DESIGN-ARCH-069] §4 的第 ③ 步）。
 *
 * 幂等且无副作用地可重复调用：
 *   - 已 active → 直接返回它，不重复 require。
 *   - 从未被发现 → null（走调用方既有的「未知命令 / 未知工具」路径，不新增分支）。
 *   - `disabled:*` → null。那是**试过并失败**的终态，不在这里重试；重试会把一个
 *     启动期就 5 秒超时的拓展变成每次调用都卡 5 秒。
 *
 * @param {string} namespace - 拓展命名空间
 * @param {object} [opts] - { contextFactory, logger } 覆盖 init() 留存的那一份
 * @returns {Promise<object|null>} 激活后的 LoadedPlugin，失败/不适用则 null
 */
async function activateNamespace(namespace, opts = {}) {
  const entry = _loadedPlugins.get(namespace);
  if (!entry) {
    return null;
  }
  if (entry.state === 'active') {
    return entry;
  }
  if (entry.state !== STATE_DISCOVERED) {
    return null; // loading / disabled:* 都不在这里插手
  }

  const contextFactory = opts.contextFactory || _contextFactory;
  if (typeof contextFactory !== 'function') {
    return null; // 没有 ctx 工厂就无法给拓展注入能力 —— 宁可不激活
  }
  const log = opts.logger || _logger || console;

  entry.state = 'loading';
  await activatePlugin(entry.manifest, entry.path, entry.source, contextFactory, log);
  return entry.state === 'active' ? entry : null;
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

  // 4. 拓展根扫描（仓库内置 + 用户安装 + KHY_EXTENSION_PATH）——**惰性**，见文件头注释
  const extPlugins = discoverFromExtensionRoots(log);
  for (const c of extPlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: c.source, lazy: true });
    }
  }

  // 5. plugin data-home directories scan (includes legacy ~/.khy/plugins)
  const dirPlugins = discoverFromPluginsDir(log);
  for (const c of dirPlugins) {
    if (!seenNames.has(c.manifestData.name)) {
      seenNames.add(c.manifestData.name);
      candidates.push({ ...c, source: 'dir' });
    }
  }

  // 6. KHY_PLUGINS environment variable
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
      if (!fs.existsSync(configPath)) {
        continue;
      }
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!Array.isArray(config.plugins)) {
        continue;
      }

      for (const entry of config.plugins) {
        const pluginPath = typeof entry === 'string' ? entry : entry.path;
        if (!pluginPath) {
          continue;
        }

        const resolved = path.isAbsolute(pluginPath) ? pluginPath : path.resolve(pluginPath);
        if (seenPaths.has(resolved)) {
          continue;
        }
        seenPaths.add(resolved);

        const manifest = readManifest(resolved);
        if (manifest) {
          results.push({ manifestData: manifest, pluginPath: resolved });
        }
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
    path.resolve(__dirname, '../../../'), // backend/
    path.resolve(__dirname, '../../../../'), // workspace root
  ]);

  if (process.env.KHYQUANT_ROOT) {
    roots.add(path.resolve(process.env.KHYQUANT_ROOT));
  }

  for (const root of roots) {
    const nmDir = path.join(root, 'node_modules');
    if (!fs.existsSync(nmDir)) {
      continue;
    }

    try {
      // Scan top-level for khy-* packages
      const entries = fs.readdirSync(nmDir);
      for (const entry of entries) {
        if (entry.startsWith('khy-')) {
          const pluginPath = path.join(nmDir, entry);
          if (!seenPaths.has(pluginPath)) {
            seenPaths.add(pluginPath);
            const manifest = readManifest(pluginPath);
            if (manifest) {
              results.push({ manifestData: manifest, pluginPath });
            }
          }
        }
        // Scan @scope/khy-* packages
        if (entry.startsWith('@')) {
          const scopeDir = path.join(nmDir, entry);
          try {
            const scopedEntries = fs.readdirSync(scopeDir);
            for (const scoped of scopedEntries) {
              if (!scoped.startsWith('khy-')) {
                continue;
              }
              const pluginPath = path.join(scopeDir, scoped);
              if (seenPaths.has(pluginPath)) {
                continue;
              }
              seenPaths.add(pluginPath);
              const manifest = readManifest(pluginPath);
              if (manifest) {
                results.push({ manifestData: manifest, pluginPath });
              }
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
    const globalNm =
      process.platform === 'win32'
        ? path.join(prefix, 'node_modules')
        : path.join(prefix, 'lib', 'node_modules');
    if (!fs.existsSync(globalNm)) {
      return results;
    }

    const entries = fs.readdirSync(globalNm);
    for (const entry of entries) {
      if (entry.startsWith('khy-') && entry !== 'khy') {
        const pluginPath = path.join(globalNm, entry);
        const manifest = readManifest(pluginPath);
        if (manifest) {
          results.push({ manifestData: manifest, pluginPath });
        }
      }
    }
  } catch {}
  return results;
}

/**
 * 从 extensionRoots 的全部根发现拓展。
 *
 * 与其他发现源的两点不同：
 *   - manifest 由 `extensionRoots.readManifest` 读，因此 `khy.extension.json`（canonical）
 *     与 `package.json#khy`（遗留）都认得 —— 本加载器自己的 readManifest 只认后者。
 *   - 只收 `kind: 'runtime'` 且声明了 `main` 的：`ide-bridge`（VSIX 之类交付给外部 IDE
 *     的产物）和 `asset` 根本没有可激活的入口，把它们当插件加载只会产生噪音告警。
 *
 * 被显式禁用（`extensions_state.json` 里 `enabled: false`）的拓展不会出现在这里 ——
 * discover() 已经过滤掉了，与 pluginContribResolver 的双门语义一致。
 *
 * @returns {Array<{manifestData: object, pluginPath: string, source: string}>}
 */
function discoverFromExtensionRoots(log) {
  const results = [];
  let found;
  try {
    found = extensionRoots.discover();
  } catch (err) {
    if (log && log.warn) {
      log.warn(`  ⚠ 拓展根扫描失败，已跳过该发现源: ${err && err.message ? err.message : err}`);
    }
    return results; // fail-soft：一个源坏掉不影响其余四个
  }

  for (const ext of found) {
    if (ext.kind !== 'runtime' || !ext.main) {
      continue;
    }
    results.push({
      // manifestData 用本加载器消费的形状；namespace / engines 已由 extensionRoots 归一。
      manifestData: {
        name: ext.name,
        displayName: ext.displayName,
        version: ext.version,
        description: ext.description,
        namespace: ext.namespace,
        engines: ext.engines,
        main: ext.main,
        capabilities: ext.capabilities,
        permissions: ext.permissions,
      },
      pluginPath: ext.dir,
      // source 如实带上根的来源（builtin / user / override），便于 `khy plugin status`
      // 一眼看出这个拓展是随包来的还是用户装的。
      source: `ext:${ext.source}`,
    });
  }
  return results;
}

function discoverFromPluginsDir(log) {
  const results = [];

  for (const dir of [KHY_PLUGINS_DIR, LEGACY_KHY_PLUGINS_DIR]) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const pluginPath = path.join(dir, entry.name);
        const manifest = readManifest(pluginPath);
        if (manifest) {
          results.push({ manifestData: manifest, pluginPath });
        }
      }
    } catch {}
  }

  return results;
}

function discoverFromEnv(log) {
  const results = [];
  const envVal = process.env.KHY_PLUGINS;
  if (!envVal) {
    return results;
  }

  const names = envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of names) {
    // Try to find it via require.resolve
    try {
      const pkgJsonPath = require.resolve(`${name}/package.json`);
      const pluginPath = path.dirname(pkgJsonPath);
      const manifest = readManifest(pluginPath);
      if (manifest) {
        results.push({ manifestData: manifest, pluginPath });
      }
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
    if (!fs.existsSync(pkgJsonPath)) {
      return null;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    if (!pkg.khy) {
      return null;
    }

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
  if (!entry) {
    return;
  }

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
          if (activationTimer.unref) {
            activationTimer.unref();
          }
        }),
      ]);
    } finally {
      if (activationTimer) {
        clearTimeout(activationTimer);
      }
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
  activateNamespace,
  discoverPlugins,
  discoverFromExtensionRoots,
  readManifest,
  STATE_DISCOVERED,
  // Manifest validator: @khy/plugin-sdk when installed, else the built-in
  // fallback — exported so callers/tests validate against the same function
  // the loader actually uses.
  validateManifest,
  KHY_HOME,
  KHY_PLUGINS_DIR,
};
