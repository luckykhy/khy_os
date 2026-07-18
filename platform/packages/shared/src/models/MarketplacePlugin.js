/**
 * Marketplace plugin (catalog entry) — Coze-compatible HTTP tool plugin.
 *
 * One row = one published plugin in the self-hosted marketplace. A plugin is a
 * stateless HTTP tool described by an OpenAPI-3 document plus a Coze/ChatGPT-
 * lineage manifest (name_for_model / description_for_model / auth / api). Each
 * OpenAPI operation becomes a callable tool at runtime (see pluginToolBridge).
 *
 * Catalog entries are shared (not per-user): official built-ins and user-
 * published plugins live in the same table, distinguished by `official`. A user
 * "installs" a plugin by creating a UserInstalledPlugin row (a lightweight link
 * + per-user auth config) — the catalog row itself is never deep-copied, because
 * the plugin carries no per-user state.
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const MarketplacePlugin = sequelize.define('MarketplacePlugin', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  slug: {
    type: DataTypes.STRING(120),
    allowNull: false,
    unique: true,
    comment: 'Stable identifier used in tool names (plugin__<slug>__<operationId>)',
  },
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
    comment: 'Human-friendly plugin name',
  },
  description: {
    type: DataTypes.STRING(1000),
    defaultValue: '',
    comment: 'Catalog description (model-facing description lives in the manifest)',
  },
  category: {
    type: DataTypes.STRING(64),
    defaultValue: 'general',
    comment: 'Marketplace category for browse/filter',
  },
  author: {
    type: DataTypes.STRING(120),
    defaultValue: '',
    comment: 'Publisher / source attribution',
  },
  official: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'True for built-in/curated plugins shipped with khy',
  },
  version: {
    type: DataTypes.STRING(32),
    defaultValue: '1.0.0',
    comment: 'Plugin version string from the manifest',
  },
  publisherId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    field: 'publisher_id',
    comment: 'User who published this plugin (null for official built-ins)',
  },
  manifestJson: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    field: 'manifest_json',
    comment: 'Coze-compatible manifest { name_for_model, description_for_model, auth, api }',
    set(value) {
      this.setDataValue('manifestJson', JSON.stringify(value == null ? {} : value));
    },
    get() {
      const raw = this.getDataValue('manifestJson');
      try {
        return JSON.parse(raw || '{}');
      } catch {
        return {};
      }
    },
  },
  openapiJson: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    field: 'openapi_json',
    comment: 'Normalized OpenAPI-3 document (single source for operation → tool projection)',
    set(value) {
      this.setDataValue('openapiJson', JSON.stringify(value == null ? {} : value));
    },
    get() {
      const raw = this.getDataValue('openapiJson');
      try {
        return JSON.parse(raw || '{}');
      } catch {
        return {};
      }
    },
  },
}, {
  tableName: 'marketplace_plugins',
  timestamps: true,
  indexes: [
    { fields: ['slug'], unique: true },
    { fields: ['category'] },
    { fields: ['official'] },
  ],
});

module.exports = MarketplacePlugin;
