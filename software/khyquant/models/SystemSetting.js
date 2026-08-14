/**
 * SystemSetting Model - System Configuration Storage
 *
 * Stores system-level key-value settings with type awareness,
 * categorization, and access control (public/private).
 * Referenced in thesis Table 16-21 as part of the data governance layer.
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const SystemSetting = sequelize.define('SystemSetting', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  key: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    comment: 'Setting key (dotted namespace, e.g. system.name)'
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Setting value (stored as string, parsed by type)'
  },
  defaultValue: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Default value for reset operations'
  },
  type: {
    type: DataTypes.STRING(20),
    defaultValue: 'string',
    comment: 'Value type: string | number | boolean | json | text'
  },
  category: {
    type: DataTypes.STRING(50),
    defaultValue: 'general',
    comment: 'Setting category for grouping (system/user/security/trading/data/notification)'
  },
  description: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: 'Human-readable description'
  },
  isPublic: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Whether this setting is visible to non-admin users'
  },
  isEditable: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    comment: 'Whether this setting can be modified via the admin panel'
  },
  validation: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON validation rules (min, max, enum, regex, etc.)'
  },
  order: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: 'Display order within category'
  }
}, {
  tableName: 'system_settings',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['key'] },
    { fields: ['category'] },
    { fields: ['is_public'] }
  ]
});

/**
 * Parse the stored string value according to the type field.
 * @returns {*} Parsed value (string, number, boolean, or object)
 */
SystemSetting.prototype.getParsedValue = function () {
  const raw = this.value;
  if (raw === null || raw === undefined) return null;

  switch (this.type) {
    case 'number':
      return Number(raw);
    case 'boolean':
      return raw === 'true' || raw === '1';
    case 'json':
      try { return JSON.parse(raw); } catch { return raw; }
    default:
      return raw;
  }
};

/**
 * Serialize a JS value into the string representation stored in the DB.
 * @param {*} val - The value to store
 */
SystemSetting.prototype.setValue = function (val) {
  if (val === null || val === undefined) {
    this.value = null;
    return;
  }

  switch (this.type) {
    case 'json':
      this.value = typeof val === 'string' ? val : JSON.stringify(val);
      break;
    default:
      this.value = String(val);
  }
};

module.exports = SystemSetting;
