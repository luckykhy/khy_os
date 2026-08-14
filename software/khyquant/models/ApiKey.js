/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize } = require('../config/database');

const ApiKey = sequelize.define('ApiKey', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this API key'
  },
  keyHash: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
    field: 'key_hash',
    comment: 'SHA-256 hash of the API key — original shown only at creation time'
  },
  keyPrefix: {
    type: DataTypes.STRING(16),
    allowNull: false,
    field: 'key_prefix',
    comment: 'First 12 chars of key — safe to display in UI/logs'
  },
  label: {
    type: DataTypes.STRING(100),
    defaultValue: 'default',
    comment: 'User-friendly label for this key'
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
    comment: 'false = revoked / rotated out'
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'last_used_at',
    comment: 'Timestamp of last successful authentication with this key'
  }
}, {
  tableName: 'api_keys',
  timestamps: true
});

module.exports = ApiKey;
