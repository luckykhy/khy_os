/**
 * 标的列表Model
 * 存储金融标的基本信息
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Instrument = sequelize.define('Instrument', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    unique: true,
    comment: '标的代码 (如: sh000001, sz399001)'
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false,
    comment: '标的名称 (如: 上证指数)'
  },
  type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: '标的类型 (index/stock/etf/bond/futures)'
  },
  market: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: '交易市场 (SSE/SZSE/CFFEX等)'
  },
  category: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: '分类 (指数/A股/ETF/债券)'
  },
  listing_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
    comment: '上市日期'
  },
  status: {
    type: DataTypes.STRING(20),
    defaultValue: 'active',
    comment: '状态 (active/suspended/delisted)'
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    field: 'created_at'
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    field: 'updated_at'
  }
}, {
  tableName: 'instruments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['symbol'] },
    { fields: ['type'] },
    { fields: ['category'] },
    { fields: ['status'] }
  ]
});

module.exports = Instrument;
