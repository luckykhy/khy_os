/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const Announcement = sequelize.define('Announcement', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  title: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: '公告标题'
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '公告内容'
  },
  type: {
    type: DataTypes.ENUM('system', 'maintenance', 'feature', 'warning', 'info'),
    defaultValue: 'info',
    comment: '公告类型：system-系统公告，maintenance-维护公告，feature-功能更新，warning-警告，info-信息'
  },
  priority: {
    type: DataTypes.ENUM('low', 'normal', 'high', 'urgent'),
    defaultValue: 'normal',
    comment: '优先级：low-低，normal-普通，high-高，urgent-紧急'
  },
  status: {
    type: DataTypes.ENUM('draft', 'published', 'archived'),
    defaultValue: 'draft',
    comment: '状态：draft-草稿，published-已发布，archived-已归档'
  },
  publishAt: {
    type: DataTypes.DATE,
    field: 'publish_at',
    comment: '发布时间'
  },
  expireAt: {
    type: DataTypes.DATE,
    field: 'expire_at',
    comment: '过期时间'
  },
  isSticky: {
    type: DataTypes.BOOLEAN,
    field: 'is_sticky',
    defaultValue: false,
    comment: '是否置顶'
  },
  isPopup: {
    type: DataTypes.BOOLEAN,
    field: 'is_popup',
    defaultValue: false,
    comment: '是否弹窗显示'
  },
  targetUsers: {
    type: jsonType,
    field: 'target_users',
    defaultValue: [],
    comment: '目标用户（空数组表示所有用户）'
  },
  readCount: {
    type: DataTypes.INTEGER,
    field: 'read_count',
    defaultValue: 0,
    comment: '阅读次数'
  },
  author_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '发布者ID'
  },
  metadata: {
    type: jsonType,
    defaultValue: {},
    comment: '元数据'
  }
}, {
  tableName: 'announcements',
  timestamps: true,
  indexes: [
    {
      fields: ['status', 'publish_at']
    },
    {
      fields: ['type', 'priority']
    },
    {
      fields: ['is_sticky', 'publish_at']
    }
  ]
});

module.exports = Announcement;