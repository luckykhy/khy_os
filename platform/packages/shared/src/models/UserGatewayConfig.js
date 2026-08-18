/**
 * Per-user gateway relay configuration (multi-tenant).
 *
 * The per-user analogue of the global relay/model config that
 * historically lived only in services/.env. One row per user; a user's
 * Claude Code / data-plane request resolves to THIS row's upstream
 * instead of the global config (see userGatewayResolver + dataPlaneEnforcer).
 *
 * Absence of a row (or an incomplete one without baseUrl) means the user
 * has not opted in — the data plane falls back to the existing global /
 * managed-customer / open path, preserving zero regression.
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { encryptField, decryptField } = require('../utils/fieldCrypto');

const UserGatewayConfig = sequelize.define('UserGatewayConfig', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
    field: 'user_id',
    comment: 'Owner — one gateway config per user',
  },
  apiFormat: {
    type: DataTypes.STRING(32),
    defaultValue: 'openai',
    field: 'api_format',
    comment: 'Upstream wire protocol: openai, anthropic, openai_responses, gemini',
  },
  baseUrl: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    field: 'base_url',
    comment: 'Upstream relay endpoint; empty = config incomplete (no isolation)',
  },
  model: {
    type: DataTypes.STRING(200),
    defaultValue: '',
    comment: 'Default upstream model id',
  },
  apiKey: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'api_key',
    comment: 'Upstream credential (AES-256-GCM at rest)',
    set(value) {
      this.setDataValue('apiKey', value == null ? value : encryptField(value));
    },
    get() {
      const raw = this.getDataValue('apiKey');
      return raw ? decryptField(raw) : raw;
    },
  },
  apiKeyField: {
    type: DataTypes.STRING(32),
    defaultValue: 'authorization_bearer',
    field: 'api_key_field',
    comment: 'Auth header style: authorization_bearer, x-api-key, x-goog-api-key',
  },
  endpoints: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    comment: 'JSON array of failover endpoint candidates',
    get() {
      const raw = this.getDataValue('endpoints');
      try { return JSON.parse(raw || '[]'); } catch { return []; }
    },
    set(val) {
      this.setDataValue('endpoints', JSON.stringify(val || []));
    },
  },
  compatibility: {
    type: DataTypes.STRING(32),
    defaultValue: 'openai',
    comment: 'Legacy compatibility hint (openai/anthropic)',
  },
  imageBackend: {
    type: DataTypes.STRING(32),
    defaultValue: '',
    field: 'image_backend',
    comment: 'Preferred image-generation backend (openai/agnes/domestic/sd_webui); empty = auto',
  },
  imageModel: {
    type: DataTypes.STRING(200),
    defaultValue: '',
    field: 'image_model',
    comment: 'Preferred image-generation model id for the chosen backend',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
  },
}, {
  tableName: 'user_gateway_configs',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['user_id'] },
  ],
});

module.exports = UserGatewayConfig;
