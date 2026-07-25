/**
 * Plugin tool bridge — make a user's installed Coze-compatible plugins callable
 * as tools, from BOTH the workflow `toolCall` node and the chat Agent.
 *
 * A plugin operation is exposed under the stable name `plugin__<slug>__<op>`
 * (see @khy/shared/plugins/openapiTools). This bridge:
 *   - listUserPluginTools(userId): enumerate enabled plugins → tool descriptors
 *     (name + description + JSON-Schema input), for the agent tool list and the
 *     workflow tool picker.
 *   - executePluginTool(name, args, traceCtx): resolve the plugin by slug for the
 *     calling user (traceCtx.userId), load that user's auth config, and run the
 *     operation through pluginInvoker.
 *
 * Dynamic + per-user by nature, so plugin tools are NOT in the static tool
 * registry; executeTool short-circuits to this bridge when it sees the prefix.
 *
 * @module services/plugins/pluginToolBridge
 * @pattern Adapter
 */
'use strict';

const {
  parseToolName,
  isPluginTool,
  listOperations,
  operationToTool,
} = require('@khy/shared/plugins/openapiTools');
const pluginInvoker = require('./pluginInvoker');

function _models() {
  // Lazy require so this module can load before the DB is wired in tests.
  return require('@khy/shared/models');
}

/**
 * Load one enabled installed plugin for a user by slug. Returns the joined
 * { plugin (catalog row), installation, authConfig } or null.
 */
async function _loadUserPluginBySlug(userId, slug) {
  const { MarketplacePlugin, UserInstalledPlugin } = _models();
  const plugin = await MarketplacePlugin.findOne({ where: { slug } });
  if (!plugin) return null;
  const installation = await UserInstalledPlugin.findOne({
    where: { userId, pluginId: plugin.id },
  });
  if (!installation || !installation.enabled) return null;
  return { plugin, installation, authConfig: installation.authConfigJson || { type: 'none' } };
}

/**
 * Enumerate the tool descriptors for every ENABLED plugin a user has installed.
 * @param {number|string} userId
 * @returns {Promise<Array<{name,description,input_schema,slug,operationId}>>}
 */
async function listUserPluginTools(userId) {
  if (userId == null) return [];
  const { MarketplacePlugin, UserInstalledPlugin } = _models();
  const installs = await UserInstalledPlugin.findAll({
    where: { userId, enabled: true },
  });
  if (!installs.length) return [];

  const byId = new Map();
  const plugins = await MarketplacePlugin.findAll({
    where: { id: installs.map((i) => i.pluginId) },
  });
  for (const p of plugins) byId.set(p.id, p);

  const tools = [];
  for (const inst of installs) {
    const plugin = byId.get(inst.pluginId);
    if (!plugin) continue;
    const openapi = plugin.openapiJson;
    for (const op of listOperations(openapi)) {
      const tool = operationToTool(openapi, plugin.slug, op.operationId);
      tools.push({ ...tool, slug: plugin.slug });
    }
  }
  return tools;
}

/**
 * Execute a plugin tool by its `plugin__<slug>__<op>` name.
 * @param {string} toolName
 * @param {object} args
 * @param {object} traceContext   must carry { userId }
 * @returns {Promise<{success,status?,data?,error?}>}
 */
async function executePluginTool(toolName, args = {}, traceContext = {}) {
  const parsed = parseToolName(toolName);
  if (!parsed) {
    return { success: false, error: `Not a plugin tool: ${toolName}` };
  }
  const userId = traceContext && (traceContext.userId != null ? traceContext.userId : traceContext.user_id);
  if (userId == null) {
    return { success: false, error: 'Plugin tools require a user context (no userId in traceContext)' };
  }

  let loaded;
  try {
    loaded = await _loadUserPluginBySlug(userId, parsed.slug);
  } catch (err) {
    return { success: false, error: `Failed to load plugin "${parsed.slug}": ${err.message}` };
  }
  if (!loaded) {
    return { success: false, error: `Plugin "${parsed.slug}" is not installed or not enabled for this user` };
  }

  try {
    const res = await pluginInvoker.invoke({
      openapi: loaded.plugin.openapiJson,
      manifest: loaded.plugin.manifestJson,
      operationId: parsed.operationId,
      args,
      authConfig: loaded.authConfig,
    });
    return {
      success: res.ok,
      status: res.status,
      data: res.data,
      ...(res.ok ? {} : { error: `Plugin returned HTTP ${res.status}` }),
    };
  } catch (err) {
    const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    return { success: false, status, error: err.message };
  }
}

module.exports = {
  isPluginTool,
  listUserPluginTools,
  executePluginTool,
  // exported for tests
  _loadUserPluginBySlug,
};
