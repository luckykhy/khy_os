/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const crypto = require('crypto');
const { sequelize } = require('../config/database');

// AES-256-GCM encryption helpers for sensitive fields
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function _getEncryptionKey() {
  const hex = process.env.FIELD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!hex || hex.length < 32) return null;
  return crypto.createHash('sha256').update(hex).digest();
}

function encryptField(plaintext) {
  const key = _getEncryptionKey();
  if (!key) return plaintext; // graceful fallback in dev
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptField(stored) {
  const key = _getEncryptionKey();
  if (!key) return stored;
  try {
    const buf = Buffer.from(stored, 'base64');
    if (buf.length < IV_LEN + TAG_LEN + 1) return stored; // not encrypted
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, null, 'utf8') + decipher.final('utf8');
  } catch {
    return stored; // plaintext legacy value
  }
}

const AIAccount = sequelize.define('AIAccount', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  provider: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'AI provider: deepseek, openai, anthropic, qwen, glm, doubao, wenxin, relay',
  },
  label: {
    type: DataTypes.STRING(100),
    defaultValue: '',
    comment: 'Human-readable label',
  },
  email: {
    type: DataTypes.STRING(255),
    defaultValue: '',
    comment: 'Account email (optional)',
  },
  apiKey: {
    type: DataTypes.STRING(512),
    allowNull: false,
    field: 'api_key',
    comment: 'Encrypted API key or access token (AES-256-GCM)',
    set(value) {
      this.setDataValue('apiKey', encryptField(value));
    },
    get() {
      const raw = this.getDataValue('apiKey');
      return raw ? decryptField(raw) : raw;
    },
  },
  endpoint: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    comment: 'Custom API endpoint URL',
  },
  tier: {
    type: DataTypes.STRING(10),
    defaultValue: 'FREE',
    comment: 'Account tier: FREE, PRO, ULTRA',
    validate: { isIn: [['FREE', 'PRO', 'ULTRA']] },
  },
  priority: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'Manual priority boost (higher = preferred)',
  },
  status: {
    type: DataTypes.STRING(20),
    defaultValue: 'active',
    comment: 'active, cooldown, disabled, circuit_open',
    validate: { isIn: [['active', 'cooldown', 'disabled', 'circuit_open']] },
  },
  healthScore: {
    type: DataTypes.FLOAT,
    defaultValue: 1.0,
    field: 'health_score',
    comment: 'Health score 0.0 to 1.0',
  },
  quotaRemaining: {
    type: DataTypes.FLOAT,
    defaultValue: 100.0,
    field: 'quota_remaining',
    comment: 'Remaining quota percentage 0-100',
  },
  quotaResetAt: {
    type: DataTypes.DATE,
    field: 'quota_reset_at',
    comment: 'When quota resets',
  },
  totalRequests: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'total_requests',
  },
  totalFailures: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'total_failures',
  },
  consecutiveFails: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'consecutive_fails',
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    field: 'last_used_at',
  },
  lastErrorAt: {
    type: DataTypes.DATE,
    field: 'last_error_at',
  },
  lastError: {
    type: DataTypes.STRING(500),
    field: 'last_error',
  },
  cooldownUntil: {
    type: DataTypes.DATE,
    field: 'cooldown_until',
  },
  circuitOpenUntil: {
    type: DataTypes.DATE,
    field: 'circuit_open_until',
  },
  backoffLevel: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'backoff_level',
  },
  config: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    comment: 'Extensible JSON config (protected models, etc.)',
    get() {
      const raw = this.getDataValue('config');
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    },
    set(val) {
      this.setDataValue('config', JSON.stringify(val || {}));
    },
  },
  disabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Manually disabled by admin',
  },
}, {
  tableName: 'ai_accounts',
  timestamps: true,
  indexes: [
    { fields: ['provider'] },
    { fields: ['status'] },
    { fields: ['tier'] },
  ],
});

module.exports = AIAccount;
