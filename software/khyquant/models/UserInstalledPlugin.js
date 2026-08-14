/**
 * Per-user installed plugin (multi-tenant link + auth config).
 *
 * One row = one marketplace plugin installed by one user. Installation is a
 * lightweight link to a MarketplacePlugin catalog row plus this user's own auth
 * configuration (API key / bearer / OAuth client credentials) — the plugin is a
 * stateless HTTP tool, so there is nothing to deep-copy.
 *
 * `auth_config_json` holds secrets and is AES-256-GCM encrypted at rest via the
 * shared fieldCrypto util (same mechanism as UserProvider.key). The decrypted
 * value is a plain object, e.g.:
 *   { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: '...' }
 *   { type: 'bearer', token: '...' }
 *   { type: 'oauth', grant: 'client_credentials', tokenUrl, clientId, clientSecret, scope }
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

const UserInstalledPlugin = sequelize.define('UserInstalledPlugin', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this installation',
  },
  pluginId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'plugin_id',
    comment: 'FK → marketplace_plugins.id',
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    comment: 'When false, the plugin tools are hidden from workflows and the chat agent',
  },
  authConfigJson: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'auth_config_json',
    comment: 'Per-user auth config object (AES-256-GCM at rest)',
    set(value) {
      // Store as encrypted JSON; null/undefined clears the config.
      if (value == null) {
        this.setDataValue('authConfigJson', null);
        return;
      }
      this.setDataValue('authConfigJson', encryptField(JSON.stringify(value)));
    },
    get() {
      const raw = this.getDataValue('authConfigJson');
      if (!raw) return null;
      try {
        return JSON.parse(decryptField(raw));
      } catch {
        return null;
      }
    },
  },
}, {
  tableName: 'user_installed_plugins',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['user_id', 'plugin_id'], unique: true },
  ],
});

module.exports = UserInstalledPlugin;
