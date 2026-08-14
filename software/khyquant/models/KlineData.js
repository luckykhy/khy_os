/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const KlineData = sequelize.define('KlineData', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  period: {
    type: DataTypes.STRING(10),
    allowNull: false,
    comment: 'daily/weekly/monthly/1min/5min/15min/30min/60min'
  },
  trade_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    field: 'trade_date'
  },
  open_price: {
    type: DataTypes.DECIMAL(12, 4),
    allowNull: true,
    field: 'open_price'
  },
  high_price: {
    type: DataTypes.DECIMAL(12, 4),
    allowNull: true,
    field: 'high_price'
  },
  low_price: {
    type: DataTypes.DECIMAL(12, 4),
    allowNull: true,
    field: 'low_price'
  },
  close_price: {
    type: DataTypes.DECIMAL(12, 4),
    allowNull: true,
    field: 'close_price'
  },
  volume: {
    type: DataTypes.BIGINT,
    allowNull: true
  },
  amount: {
    type: DataTypes.DECIMAL(20, 4),
    allowNull: true
  },
  change_amount: {
    type: DataTypes.DECIMAL(12, 4),
    allowNull: true,
    field: 'change_amount'
  },
  change_percent: {
    type: DataTypes.DECIMAL(8, 4),
    allowNull: true,
    field: 'change_percent'
  },
  turnover_rate: {
    type: DataTypes.DECIMAL(8, 4),
    allowNull: true,
    field: 'turnover_rate'
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
  tableName: 'kline_data',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['symbol', 'period', 'trade_date']
    },
    {
      fields: ['symbol']
    },
    {
      fields: ['trade_date']
    },
    {
      fields: ['symbol', 'period']
    },
    {
      fields: ['symbol', 'trade_date']
    }
  ]
});

module.exports = KlineData;
