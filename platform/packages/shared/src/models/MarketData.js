/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const MarketData = sequelize.define('MarketData', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: '股票代码'
  },
  timestamp: {
    type: DataTypes.DATE,
    allowNull: false,
    comment: '时间戳'
  },
  open_price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    comment: '开盘价'
  },
  high_price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    comment: '最高价'
  },
  low_price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    comment: '最低价'
  },
  close_price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    comment: '收盘价'
  },
  volume: {
    type: DataTypes.BIGINT,
    allowNull: false,
    comment: '成交量'
  }
}, {
  tableName: 'market_data',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['symbol', 'timestamp']
    },
    {
      fields: ['symbol']
    },
    {
      fields: ['timestamp']
    }
  ]
});

module.exports = MarketData;