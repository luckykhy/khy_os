/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserLog = sequelize.define('UserLog', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: '操作类型：login, logout, register, password_change, profile_update等'
  },
  actionDescription: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '操作描述'
  },
  ipAddress: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '用户IP地址'
  },
  userAgent: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '用户浏览器信息'
  },
  sessionId: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: '会话ID'
  },
  status: {
    type: DataTypes.ENUM('success', 'failed', 'warning'),
    defaultValue: 'success',
    comment: '操作状态'
  },
  details: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: '额外详情信息'
  },
  timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    allowNull: false
  }
}, {
  tableName: 'user_logs',
  timestamps: true,
  indexes: [
    {
      fields: ['user_id']
    },
    {
      fields: ['action']
    },
    {
      fields: ['timestamp']
    },
    {
      fields: ['status']
    }
  ]
});

module.exports = UserLog;