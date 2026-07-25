/**
 * Per-user plugin management service (multi-tenant).
 *
 * Operates on the calling user's `UserInstalledPlugin` rows (joined with the
 * shared `MarketplacePlugin` catalog): list installed, import (publish a private
 * plugin + auto-install), enable/disable, set auth config, uninstall, and a
 * one-shot `test` invoke of a single operation.
 *
 * Auth secrets (authConfigJson) are encrypted at rest by the model and are NEVER
 * returned to the client — only a masked descriptor of the auth TYPE.
 *
 * @module services/pluginService
 * @pattern Service
 */
'use strict';

const path = require('path');
const { MarketplacePlugin, UserInstalledPlugin } = require('@khy/shared/models');
const { listOperations } = require('@khy/shared/plugins/openapiTools');
const { httpError } = require('./workflowService');
const importSvc = require('./pluginImportService');

// Runtime invoker + tool bridge live in the trading backend (shared with the
// workflow node + chat Agent). ai-backend already reaches backend services this
// way; reusing the bridge keeps the tool projection a single source of truth.
const pluginInvoker = require(path.resolve(__dirname, '../../../backend/src/services/plugins/pluginInvoker'));
const pluginToolBridge = require(path.resolve(__dirname, '../../../backend/src/services/plugins/pluginToolBridge'));

/** Mask an auth config down to a non-secret descriptor for the client. */
function _maskAuth(authConfig) {
  const a = authConfig && typeof authConfig === 'object' ? authConfig : { type: 'none' };
  const type = String(a.type || 'none').toLowerCase();
  if (type === 'none') return { type: 'none' };
  if (type === 'apikey') return { type: 'apiKey', in: a.in || 'header', name: a.name || 'Authorization', configured: !!a.value };
  if (type === 'bearer') return { type: 'bearer', configured: !!a.token };
  if (type === 'oauth') {
    return {
      type: 'oauth',
      grant: a.grant || 'client_credentials',
      tokenUrl: a.tokenUrl || '',
      scope: a.scope || '',
      configured: !!(a.clientId && (a.clientSecret || a.accessToken)),
    };
  }
  return { type };
}

function _installView(install, plugin) {
  return {
    id: install.id,
    pluginId: plugin ? plugin.id : install.pluginId,
    slug: plugin ? plugin.slug : null,
    name: plugin ? plugin.name : null,
    description: plugin ? plugin.description : '',
    category: plugin ? plugin.category : null,
    official: plugin ? !!plugin.official : false,
    version: plugin ? plugin.version : null,
    enabled: !!install.enabled,
    auth: _maskAuth(install.authConfigJson),
    operations: plugin ? listOperations(plugin.openapiJson).length : 0,
  };
}

/** Load an install owned by the user (404 otherwise) + its catalog row. */
async function _ownedInstall(userId, installId) {
  const install = await UserInstalledPlugin.findOne({ where: { id: installId, userId } });
  if (!install) throw httpError(404, 'Installed plugin not found');
  const plugin = await MarketplacePlugin.findByPk(install.pluginId);
  return { install, plugin };
}

/**
 * List the callable tool descriptors for the user's ENABLED plugins — exactly
 * the names the workflow `toolCall` node + chat Agent dispatch on
 * (`plugin__<slug>__<op>`). Reuses the runtime bridge so the picker can never
 * drift from what actually executes.
 */
async function listTools(userId) {
  if (userId == null) return [];
  return pluginToolBridge.listUserPluginTools(userId);
}

/** List the calling user's installed plugins. */
async function listInstalled(userId) {
  const installs = await UserInstalledPlugin.findAll({ where: { userId }, order: [['id', 'ASC']] });
  if (!installs.length) return [];
  const byId = new Map();
  const plugins = await MarketplacePlugin.findAll({ where: { id: installs.map((i) => i.pluginId) } });
  for (const p of plugins) byId.set(p.id, p);
  return installs.map((i) => _installView(i, byId.get(i.pluginId)));
}

/** Preview a plugin import WITHOUT persisting (delegates to the importer). */
async function preview(body = {}) {
  const norm = await importSvc.preview(body);
  // Drop the full openapi blob from the preview envelope; keep operations.
  const { openapi, ...rest } = norm; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * Import a plugin (publish a private catalog row) + auto-install it for the user.
 * Body: pluginImportService input + optional { authConfig }.
 */
async function importAndInstall(userId, body = {}) {
  if (userId == null) throw httpError(401, 'Authentication required');
  const plugin = await importSvc.importPlugin(userId, { ...body, official: false });
  const install = await UserInstalledPlugin.create({
    userId,
    pluginId: plugin.id,
    enabled: true,
    authConfigJson: body.authConfig !== undefined ? body.authConfig : (plugin.manifestJson && plugin.manifestJson.auth) || { type: 'none' },
  });
  return _installView(install, plugin);
}

/** Enable/disable an installed plugin. */
async function setEnabled(userId, installId, enabled) {
  const { install, plugin } = await _ownedInstall(userId, installId);
  install.enabled = !!enabled;
  await install.save();
  return _installView(install, plugin);
}

/** Replace the auth config of an installed plugin. */
async function setAuth(userId, installId, authConfig) {
  const { install, plugin } = await _ownedInstall(userId, installId);
  install.authConfigJson = authConfig != null ? authConfig : { type: 'none' };
  await install.save();
  return _installView(install, plugin);
}

/** Uninstall (remove the user's install row). */
async function remove(userId, installId) {
  const { install } = await _ownedInstall(userId, installId);
  await install.destroy();
  return { uninstalled: true };
}

/**
 * One-shot test invoke of a single operation using the user's stored auth.
 * Body: { operationId, args? }.
 */
async function test(userId, installId, body = {}) {
  const { install, plugin } = await _ownedInstall(userId, installId);
  if (!plugin) throw httpError(404, 'Catalog plugin missing');
  if (!body.operationId) throw httpError(400, 'operationId is required');
  const res = await pluginInvoker.invoke({
    openapi: plugin.openapiJson,
    manifest: plugin.manifestJson,
    operationId: body.operationId,
    args: body.args || {},
    authConfig: install.authConfigJson || { type: 'none' },
  });
  return { ok: res.ok, status: res.status, contentType: res.contentType, data: res.data };
}

module.exports = {
  listInstalled,
  listTools,
  preview,
  importAndInstall,
  setEnabled,
  setAuth,
  remove,
  test,
  _maskAuth,
  _installView,
};
