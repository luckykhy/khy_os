/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AnnouncementRead = sequelize.define('AnnouncementRead', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '用户ID'
  },
  announcement_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '公告ID'
  },
  readAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    comment: '阅读时间'
  },
  isLiked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: '是否点赞'
  }
}, {
  tableName: 'announcement_reads',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['user_id', 'announcement_id']
    },
    {
      fields: ['announcement_id', 'read_at']
    }
  ]
});

module.exports = AnnouncementRead;