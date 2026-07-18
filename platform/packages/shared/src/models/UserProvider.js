/**
 * Per-user custom provider + key-pool entry (multi-tenant).
 *
 * The per-user merge of the global custom_providers.json and the global
 * api_keys.json key pool. One row = one (provider, key) entry owned by a
 * user. Carries only preset/routing metadata (baseUrl, protocol) — never
 * model capabilities, which are resolved at runtime (zero-hardcoding rule).
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

const UserProvider = sequelize.define('UserProvider', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this provider/key entry',
  },
  provider: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: 'Provider id (e.g. openai, anthropic, deepseek, custom slug)',
  },
  displayName: {
    type: DataTypes.STRING(120),
    defaultValue: '',
    field: 'display_name',
    comment: 'Human-friendly provider label',
  },
  apiFormat: {
    type: DataTypes.STRING(32),
    defaultValue: 'openai',
    field: 'api_format',
    comment: 'Upstream wire protocol for this provider',
  },
  baseUrl: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    field: 'base_url',
    comment: 'Provider base URL (preset metadata only)',
  },
  protocol: {
    type: DataTypes.STRING(32),
    defaultValue: '',
    comment: 'Optional protocol hint carried from preset',
  },
  key: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Pool entry credential (AES-256-GCM at rest)',
    set(value) {
      this.setDataValue('key', value == null ? value : encryptField(value));
    },
    get() {
      const raw = this.getDataValue('key');
      return raw ? decryptField(raw) : raw;
    },
  },
  endpoint: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    comment: 'Per-entry endpoint override',
  },
  priority: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'Pool ordering (higher = preferred)',
  },
  label: {
    type: DataTypes.STRING(120),
    defaultValue: '',
    comment: 'User-friendly label for this key entry',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
  },
}, {
  tableName: 'user_providers',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['user_id', 'provider'] },
  ],
});

module.exports = UserProvider;
