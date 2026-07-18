/**
 * 用户自选标的Model
 * 存储用户的自选标的列表
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserFavorite = sequelize.define('UserFavorite', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    },
    onDelete: 'CASCADE',
    comment: '用户ID'
  },
  symbol: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: '标的代码 (如: sh000001, sz399001)'
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: '标的名称 (如: 上证指数)'
  },
  type: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: '标的类型 (index/stock/etf/bond)'
  },
  added_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    field: 'added_at',
    comment: '添加时间'
  }
}, {
  tableName: 'user_favorites',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['user_id', 'symbol'],
      name: 'unique_user_symbol'
    },
    {
      fields: ['user_id'],
      name: 'idx_user_favorites_user_id'
    },
    {
      fields: ['symbol'],
      name: 'idx_user_favorites_symbol'
    }
  ]
});

module.exports = UserFavorite;
