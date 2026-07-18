/**
 * Plugin Chain — responsibility chain for AI gateway lifecycle hooks.
 *
 * Plugins are loaded from ~/.khyquant/gateway_plugins/ directory.
 * Each plugin exports hooks: onBeforeRequest, onAfterResponse, onError, onStream.
 *
 * Example plugin:
 *   module.exports = {
 *     name: 'example',
 *     priority: 100,
 *     hooks: {
 *       onBeforeRequest: async (ctx, next) => next(ctx),
 *       onAfterResponse: async (ctx, next) => next(ctx),
 *       onError: async (ctx, next) => next(ctx),
 *       onStream: (chunk, ctx) => chunk,
 *     },
 *   };
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGINS_DIR = process.env.GATEWAY_PLUGINS_DIR
  ? path.resolve(process.env.GATEWAY_PLUGINS_DIR.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), '.khyquant', 'gateway_plugins');

const ENABLED = process.env.GATEWAY_PLUGINS_ENABLED !== 'false';

let _plugins = [];
let _loaded = false;

/**
 * Load all plugins from disk, sorted by priority (descending).
 */
function loadPlugins() {
  _plugins = [];
  _loaded = true;

  if (!ENABLED) return;

  try {
    if (!fs.existsSync(PLUGINS_DIR)) {
      fs.mkdirSync(PLUGINS_DIR, { recursive: true });
      return;
    }

    const files = fs.readdirSync(PLUGINS_DIR).filter(f => {
      // Security: only allow simple .js filenames (no path traversal)
      if (!f.endsWith('.js')) return false;
      if (f.includes('/') || f.includes('\\') || f.includes('..')) return false;
      if (f.startsWith('.')) return false;
      return /^[a-zA-Z0-9_\-]+\.js$/.test(f);
    });

    for (const file of files) {
      try {
        const pluginPath = path.join(PLUGINS_DIR, file);
        // Clear require cache for hot-reload
        delete require.cache[require.resolve(pluginPath)];
        const plugin = require(pluginPath);

        if (!plugin.name) plugin.name = path.basename(file, '.js');
        if (!plugin.priority) plugin.priority = 0;
        if (!plugin.hooks) plugin.hooks = {};
        plugin._enabled = plugin.enabled !== false;
        plugin._file = file;

        _plugins.push(plugin);
      } catch (err) {
        console.error(`[PluginChain] Failed to load ${file}: ${err.message}`);
      }
    }

    // Sort by priority descending (higher priority runs first)
    _plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  } catch (err) {
    console.error(`[PluginChain] Error reading plugins dir: ${err.message}`);
  }
}

/**
 * Reload all plugins from disk.
 */
function reload() {
  _loaded = false;
  loadPlugins();
  return _plugins.length;
}

/**
 * Get list of loaded plugins.
 */
function list() {
  if (!_loaded) loadPlugins();
  return _plugins.map(p => ({
    name: p.name,
    priority: p.priority,
    enabled: p._enabled,
    file: p._file,
    hooks: Object.keys(p.hooks || {}),
  }));
}

/**
 * Enable or disable a plugin by name.
 */
function toggle(name, enabled) {
  if (!_loaded) loadPlugins();
  const plugin = _plugins.find(p => p.name === name);
  if (!plugin) return false;
  plugin._enabled = enabled;
  return true;
}

/**
 * Execute onBeforeRequest chain.
 * @param {object} ctx - { prompt, options, adapter, cancelled }
 * @returns {Promise<object>} Modified ctx (or ctx.cancelled = true to abort)
 */
async function executeBeforeRequest(ctx) {
  if (!_loaded) loadPlugins();
  if (!ENABLED) return ctx;

  const chain = _plugins.filter(p => p._enabled && p.hooks?.onBeforeRequest);

  for (const plugin of chain) {
    try {
      ctx = await plugin.hooks.onBeforeRequest(ctx, async (c) => c);
      if (ctx.cancelled) break;
    } catch (err) {
      console.error(`[PluginChain] ${plugin.name}.onBeforeRequest error: ${err.message}`);
    }
  }

  return ctx;
}

/**
 * Execute onAfterResponse chain.
 * @param {object} ctx - { prompt, options, response, adapter }
 * @returns {Promise<object>} Modified ctx
 */
async function executeAfterResponse(ctx) {
  if (!_loaded) loadPlugins();
  if (!ENABLED) return ctx;

  const chain = _plugins.filter(p => p._enabled && p.hooks?.onAfterResponse);

  for (const plugin of chain) {
    try {
      ctx = await plugin.hooks.onAfterResponse(ctx, async (c) => c);
    } catch (err) {
      console.error(`[PluginChain] ${plugin.name}.onAfterResponse error: ${err.message}`);
    }
  }

  return ctx;
}

/**
 * Execute onError chain.
 * @param {object} ctx - { prompt, options, error, adapter, retry }
 * @returns {Promise<object>} Modified ctx (ctx.retry = true to retry)
 */
async function executeOnError(ctx) {
  if (!_loaded) loadPlugins();
  if (!ENABLED) return ctx;

  const chain = _plugins.filter(p => p._enabled && p.hooks?.onError);

  for (const plugin of chain) {
    try {
      ctx = await plugin.hooks.onError(ctx, async (c) => c);
    } catch (err) {
      console.error(`[PluginChain] ${plugin.name}.onError error: ${err.message}`);
    }
  }

  return ctx;
}

/**
 * Execute onStream filter — synchronous, returns modified chunk or null to suppress.
 * @param {object} chunk - Stream chunk
 * @param {object} ctx - { adapter, options }
 * @returns {object|null} Modified chunk or null
 */
function executeOnStream(chunk, ctx) {
  if (!_loaded) loadPlugins();
  if (!ENABLED) return chunk;

  const chain = _plugins.filter(p => p._enabled && p.hooks?.onStream);

  let result = chunk;
  for (const plugin of chain) {
    try {
      result = plugin.hooks.onStream(result, ctx);
      if (result === null) return null; // suppress chunk
    } catch (err) {
      console.error(`[PluginChain] ${plugin.name}.onStream error: ${err.message}`);
    }
  }

  return result;
}

/**
 * Get the plugins directory path.
 */
function getPluginsDir() {
  return PLUGINS_DIR;
}

// ── Plugin CRUD Operations ──

const FILENAME_RE = /^[a-zA-Z0-9_\-]+$/;
const MAX_PLUGIN_SIZE = 100 * 1024; // 100 KB

function _validateName(name) {
  if (!name || typeof name !== 'string') throw new Error('Plugin name is required');
  // Accept with or without .js extension
  const baseName = name.endsWith('.js') ? name.slice(0, -3) : name;
  if (!FILENAME_RE.test(baseName)) {
    throw new Error('Plugin name may only contain letters, digits, hyphens, and underscores');
  }
  return baseName;
}

/**
 * Validate JavaScript source code syntax without executing it.
 * @param {string} code - Plugin source code
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSyntax(code) {
  try {
    new (require('vm').Script)(code, { filename: 'plugin-validate.js' });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Read plugin source code from disk.
 * @param {string} name - Plugin name (with or without .js)
 * @returns {string} Source code
 */
function getPluginCode(name) {
  const baseName = _validateName(name);
  const filePath = path.join(PLUGINS_DIR, `${baseName}.js`);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Plugin "${baseName}" not found`);
    throw err;
  }
}

/**
 * Write plugin source code to disk (create or update).
 * Validates syntax before writing, then reloads the plugin chain.
 * @param {string} name - Plugin name
 * @param {string} code - Source code
 * @returns {{ name: string, file: string, created: boolean }}
 */
function savePlugin(name, code) {
  const baseName = _validateName(name);

  if (!code || typeof code !== 'string') {
    throw new Error('Plugin code is required');
  }
  if (Buffer.byteLength(code, 'utf-8') > MAX_PLUGIN_SIZE) {
    throw new Error(`Plugin exceeds maximum size (${MAX_PLUGIN_SIZE / 1024} KB)`);
  }

  const check = validateSyntax(code);
  if (!check.valid) {
    throw new Error(`Syntax error: ${check.error}`);
  }

  // Ensure plugins directory exists
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }

  const filePath = path.join(PLUGINS_DIR, `${baseName}.js`);
  const existed = fs.existsSync(filePath);

  // Atomic write: write to unique temp file then rename, with cleanup on failure
  const tmpPath = filePath + `.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, code, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }

  reload();

  return { name: baseName, file: `${baseName}.js`, created: !existed };
}

/**
 * Delete a plugin file from disk and reload the chain.
 * @param {string} name - Plugin name
 * @returns {boolean} true if deleted
 */
function deletePlugin(name) {
  const baseName = _validateName(name);
  const filePath = path.join(PLUGINS_DIR, `${baseName}.js`);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Plugin "${baseName}" not found`);
    throw err;
  }
  reload();
  return true;
}

/**
 * Get template plugin source code for creating new plugins.
 * @returns {string} Template source code
 */
function getTemplate() {
  const templatePath = path.join(__dirname, 'example_plugins', 'cache-plugin.js');
  if (fs.existsSync(templatePath)) {
    return fs.readFileSync(templatePath, 'utf-8');
  }
  // Fallback minimal template
  return `/**
 * My Plugin — description here.
 *
 * Copy to ~/.khyquant/gateway_plugins/ to activate.
 */
module.exports = {
  name: 'my-plugin',
  priority: 100,
  enabled: true,
  hooks: {
    onBeforeRequest: async (ctx, next) => {
      // Modify ctx.prompt, ctx.options, or set ctx.cancelled = true
      return next(ctx);
    },

    onAfterResponse: async (ctx, next) => {
      // Inspect ctx.response
      return next(ctx);
    },

    onError: async (ctx, next) => {
      // Set ctx.retry = true to retry the request
      return next(ctx);
    },

    onStream: (chunk, ctx) => {
      // Return chunk (modified or original), or null to suppress
      return chunk;
    },
  },
};
`;
}

module.exports = {
  loadPlugins,
  reload,
  list,
  toggle,
  executeBeforeRequest,
  executeAfterResponse,
  executeOnError,
  executeOnStream,
  getPluginsDir,
  getPluginCode,
  savePlugin,
  deletePlugin,
  getTemplate,
  validateSyntax,
  ENABLED,
};
