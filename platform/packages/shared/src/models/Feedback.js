/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Feedback = sequelize.define('Feedback', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id', // 映射到数据库的 user_id 字段
    references: {
      model: 'users',
      key: 'id'
    }
  },
  title: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: '反馈标题'
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '反馈内容'
  },
  type: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'suggestion',
    comment: '反馈类型：bug(错误报告)、suggestion(建议)、feature(功能请求)、other(其他)'
  },
  priority: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'normal',
    comment: '优先级：low(低)、normal(普通)、high(高)、urgent(紧急)'
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    comment: '状态：pending(待处理)、processing(处理中)、resolved(已解决)、closed(已关闭)'
  },
  adminReply: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'admin_reply', // 映射到数据库的 admin_reply 字段
    comment: '管理员回复'
  },
  adminId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    field: 'admin_id', // 映射到数据库的 admin_id 字段
    references: {
      model: 'users',
      key: 'id'
    },
    comment: '处理的管理员ID'
  },
  repliedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'replied_at', // 映射到数据库的 replied_at 字段
    comment: '回复时间'
  },
  contactInfo: {
    type: DataTypes.STRING(100),
    allowNull: true,
    field: 'contact_info', // 映射到数据库的 contact_info 字段
    comment: '联系方式（可选）'
  },
  attachments: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: '附件信息（截图等）'
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: '额外元数据（浏览器信息、页面URL等）'
  }
}, {
  tableName: 'feedbacks',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['user_id'] // 使用数据库字段名
    },
    {
      fields: ['type']
    },
    {
      fields: ['status']
    },
    {
      fields: ['priority']
    },
    {
      fields: ['created_at']
    }
  ]
});

module.exports = Feedback;