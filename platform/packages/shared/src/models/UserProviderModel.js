/**
 * Per-user detected/known model (multi-tenant).
 *
 * One row = one (provider, model) that has been DETECTED for a user's own
 * configured upstream (probed from /v1/models) or added by the user manually.
 * UserProvider rows carry only the (provider, key) credential — never a model
 * list — so this table is the persisted home for the user's per-provider
 * models, letting "我的模型目录" populate from the user's real config while the
 * user can still add/remove models by hand. External/live sources (local
 * Ollama, the global/system plane) are merged at read time and are NOT stored
 * here — only the user's own upstreams persist (tenant isolation + freshness).
 *
 * Zero-fabrication: a model only lands here if a real probe returned it or the
 * user typed it; nothing is invented. Capability is the classifier's verdict at
 * insert time (re-derivable, stored for fast catalog reads).
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserProviderModel = sequelize.define('UserProviderModel', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this detected/added model',
  },
  provider: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: 'Provider id this model belongs to (matches UserProvider.provider or "relay")',
  },
  model: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: 'Concrete model id (probed from /v1/models or user-entered)',
  },
  capability: {
    type: DataTypes.STRING(16),
    defaultValue: 'text',
    comment: 'text|audio|image|video — classifier verdict at insert time',
  },
  source: {
    type: DataTypes.STRING(16),
    defaultValue: 'detected',
    comment: 'detected|manual — how the model entered the catalog',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
  },
}, {
  tableName: 'user_provider_models',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['user_id', 'provider'] },
    // One persisted row per (user, provider, model): the upsert dedupe key.
    { unique: true, fields: ['user_id', 'provider', 'model'] },
  ],
});

module.exports = UserProviderModel;
