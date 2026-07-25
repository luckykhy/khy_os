const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AuthSession = sequelize.define('AuthSession', {
  id: {
    type: DataTypes.STRING(64),
    primaryKey: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
  },
  refreshTokenHash: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
    field: 'refresh_token_hash',
  },
  tokenVersion: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    field: 'token_version',
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'active',
  },
  authMethod: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'password',
    field: 'auth_method',
  },
  ipAddress: {
    type: DataTypes.STRING(128),
    allowNull: true,
    field: 'ip_address',
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'user_agent',
  },
  deviceLabel: {
    type: DataTypes.STRING(160),
    allowNull: true,
    field: 'device_label',
  },
  loginAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'login_at',
  },
  lastActivityAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'last_activity_at',
  },
  lastRefreshAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'last_refresh_at',
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
    field: 'expires_at',
  },
  revokedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'revoked_at',
  },
  revokedReason: {
    type: DataTypes.STRING(120),
    allowNull: true,
    field: 'revoked_reason',
  },
}, {
  tableName: 'auth_sessions',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { unique: true, fields: ['refresh_token_hash'] },
    { fields: ['status'] },
    { fields: ['expires_at'] },
    { fields: ['revoked_at'] },
  ],
});

module.exports = AuthSession;
