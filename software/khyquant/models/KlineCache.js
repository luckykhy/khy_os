/**
 * K线缓存数据模型
 * 用于缓存从数据源获取的历史K线数据
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const KlineCache = sequelize.define('KlineCache', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: '标的代码，如sh000300'
  },
  period: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'daily',
    comment: '周期：daily, weekly, monthly'
  },
  trade_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    comment: '交易日期'
  },
  open: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
    comment: '开盘价'
  },
  high: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
    comment: '最高价'
  },
  low: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
    comment: '最低价'
  },
  close: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: false,
    comment: '收盘价'
  },
  volume: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: '成交量'
  },
  amount: {
    type: DataTypes.DECIMAL(30, 2),
    allowNull: true,
    comment: '成交额'
  },
  data_source: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: '数据来源：adata, efinance, akshare等'
  }
}, {
  tableName: 'kline_cache',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      unique: true,
      fields: ['symbol', 'period', 'trade_date'],
      name: 'idx_kline_unique'
    },
    {
      fields: ['symbol', 'period', 'trade_date'],
      name: 'idx_kline_query'
    },
    {
      fields: ['data_source'],
      name: 'idx_kline_source'
    }
  ]
});

module.exports = KlineCache;
