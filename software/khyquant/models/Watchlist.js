/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const Watchlist = sequelize.define('Watchlist', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    references: {
      model: 'users',
      key: 'id'
    }
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: '工具代码'
  },
  symbolName: {
    type: DataTypes.STRING(50),
    allowNull: false,
    field: 'symbol_name',
    comment: '工具名称'
  },
  sector: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: '所属行业'
  },
  market: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: '所属市场'
  },
  instrumentType: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'stock',
    field: 'instrument_type',
    comment: '工具类型：stock/index/futures'
  },
  category: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: '股票',
    comment: '工具分类：股票/指数/期货'
  },
  basePrice: {
    type: DataTypes.DECIMAL(15, 4),
    allowNull: true,
    field: 'base_price',
    comment: '基准价格'
  },
  contractInfo: {
    type: jsonType,
    allowNull: true,
    field: 'contract_info',
    comment: '合约信息'
  },
  addedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
    field: 'added_at',
    comment: '添加时间'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '备注信息'
  },
  alertPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    field: 'alert_price',
    comment: '价格提醒'
  },
  alertEnabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'alert_enabled',
    comment: '是否启用提醒'
  }
}, {
  tableName: 'watchlists',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      unique: true,
      fields: ['user_id', 'symbol']
    },
    {
      fields: ['user_id']
    },
    {
      fields: ['symbol']
    },
    {
      fields: ['instrument_type']
    },
    {
      fields: ['category']
    }
  ]
});

module.exports = Watchlist;