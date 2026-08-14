/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Signal = sequelize.define('Signal', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner — the user who submitted this signal'
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: 'A-share stock code, e.g. "600519"'
  },
  signal: {
    type: DataTypes.ENUM('BUY', 'SELL', 'HOLD'),
    allowNull: false,
    comment: 'Trading direction'
  },
  price: {
    type: DataTypes.DECIMAL(12, 4),
    allowNull: true,
    comment: 'Reference price at signal time'
  },
  confidence: {
    type: DataTypes.DECIMAL(5, 4),
    allowNull: true,
    comment: 'Signal confidence 0.0000 – 1.0000'
  },
  source: {
    type: DataTypes.STRING(100),
    defaultValue: 'external',
    comment: 'Origin of the signal (external, strategy, manual, …)'
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Arbitrary extra data from the caller'
  }
}, {
  tableName: 'signals',
  timestamps: true
});

module.exports = Signal;
