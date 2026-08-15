/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const Strategy = sequelize.define('Strategy', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '用户ID'
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    comment: '策略名称'
  },
  description: {
    type: DataTypes.TEXT,
    comment: '策略描述'
  },
  code: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '策略代码'
  },
  language: {
    type: DataTypes.ENUM('javascript', 'python', 'tdx'),
    defaultValue: 'javascript',
    comment: '策略语言：javascript, python, tdx'
  },
  type: {
    type: DataTypes.ENUM('trend', 'mean_reversion', 'arbitrage', 'market_making', 'other'),
    defaultValue: 'trend',
    comment: '策略类型'
  },
  parameters: {
    type: jsonType,
    defaultValue: {},
    comment: '策略参数（JSON格式）'
  },
  status: {
    type: DataTypes.ENUM('draft', 'active', 'paused', 'archived'),
    defaultValue: 'draft',
    comment: '状态：draft-草稿，active-运行中，paused-暂停，archived-已归档'
  },
  isPublic: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: '是否公开'
  }
}, {
  tableName: 'strategies',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['status'] },
    { fields: ['user_id', 'status'] }
  ]
});

module.exports = Strategy;
