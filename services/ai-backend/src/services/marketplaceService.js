/**
 * Marketplace catalog service (multi-tenant).
 *
 * The shared `MarketplacePlugin` catalog holds official + user-published plugins.
 * This service exposes browse/search/detail + install/uninstall (which create or
 * remove the calling user's `UserInstalledPlugin` link). Auth secrets live on the
 * per-user install row, never on the shared catalog.
 *
 * @module services/marketplaceService
 * @pattern Service
 */
'use strict';

const { Op } = require('sequelize');
const { MarketplacePlugin, UserInstalledPlugin } = require('@khy/shared/models');
const { listOperations } = require('@khy/shared/plugins/openapiTools');
const { httpError } = require('./workflowService');

/** Public catalog projection (never leaks the raw openapi blob in lists). */
function _summary(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    author: row.author,
    official: !!row.official,
    version: row.version,
  };
}

/**
 * List the catalog with optional search + category filter.
 * @param {object} [q] { search?, category?, official? }
 */
async function list(q = {}) {
  const where = {};
  if (q.category) where.category = String(q.category);
  if (q.official != null) where.official = !!q.official;
  if (q.search) {
    const like = { [Op.like]: `%${String(q.search).slice(0, 80)}%` };
    where[Op.or] = [{ name: like }, { description: like }, { slug: like }];
  }
  const rows = await MarketplacePlugin.findAll({ where, order: [['official', 'DESC'], ['name', 'ASC']] });
  return rows.map(_summary);
}

/** Distinct category list (for the marketplace filter chips). */
async function categories() {
  const rows = await MarketplacePlugin.findAll({
    attributes: ['category'],
    group: ['category'],
    order: [['category', 'ASC']],
  });
  return rows.map((r) => r.category).filter(Boolean);
}

/**
 * Catalog detail, including the operation (tool) list and — for the calling
 * user — whether it is installed.
 */
async function detail(userId, pluginId) {
  const row = await MarketplacePlugin.findByPk(pluginId);
  if (!row) throw httpError(404, 'Plugin not found');
  const install = userId != null
    ? await UserInstalledPlugin.findOne({ where: { userId, pluginId: row.id } })
    : null;
  return {
    ..._summary(row),
    manifest: row.manifestJson,
    operations: listOperations(row.openapiJson).map((o) => ({
      operationId: o.operationId,
      method: o.method,
      path: o.path,
      summary: o.summary,
    })),
    auth: (row.manifestJson && row.manifestJson.auth) || { type: 'none' },
    installed: !!install,
    enabled: install ? !!install.enabled : false,
    installId: install ? install.id : null,
  };
}

/**
 * Install a catalog plugin for the calling user (idempotent: re-install updates
 * the auth config + re-enables). Body may carry { authConfig }.
 */
async function install(userId, pluginId, body = {}) {
  if (userId == null) throw httpError(401, 'Authentication required');
  const plugin = await MarketplacePlugin.findByPk(pluginId);
  if (!plugin) throw httpError(404, 'Plugin not found');

  const existing = await UserInstalledPlugin.findOne({ where: { userId, pluginId: plugin.id } });
  if (existing) {
    existing.enabled = true;
    if (body.authConfig !== undefined) existing.authConfigJson = body.authConfig;
    await existing.save();
    return { id: existing.id, pluginId: plugin.id, enabled: true, installed: true };
  }
  const row = await UserInstalledPlugin.create({
    userId,
    pluginId: plugin.id,
    enabled: true,
    authConfigJson: body.authConfig !== undefined ? body.authConfig : { type: 'none' },
  });
  return { id: row.id, pluginId: plugin.id, enabled: true, installed: true };
}

/** Uninstall: remove the calling user's link to a catalog plugin. */
async function uninstall(userId, pluginId) {
  if (userId == null) throw httpError(401, 'Authentication required');
  const deleted = await UserInstalledPlugin.destroy({ where: { userId, pluginId } });
  if (!deleted) throw httpError(404, 'Plugin is not installed');
  return { uninstalled: true };
}

module.exports = {
  list,
  categories,
  detail,
  install,
  uninstall,
  _summary,
};
