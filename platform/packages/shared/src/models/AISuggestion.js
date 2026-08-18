/**
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const AISuggestion = sequelize.define('AISuggestion', {
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
  type: {
    type: DataTypes.ENUM('strategy', 'trade', 'news', 'analysis'),
    allowNull: false,
    comment: '建议类型：strategy-策略建议，trade-交易建议，news-新闻分析，analysis-市场分析'
  },
  symbol: {
    type: DataTypes.STRING(20),
    comment: '相关标的代码（可选）'
  },
  title: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: '建议标题'
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: '建议内容'
  },
  confidence: {
    type: DataTypes.DECIMAL(5, 2),
    defaultValue: 0,
    comment: '置信度（0-100）'
  },
  agentType: {
    type: DataTypes.STRING(50),
    comment: '使用的智能体类型'
  },
  metadata: {
    type: jsonType,
    defaultValue: {},
    comment: '元数据（JSON格式）'
  },
  isRead: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: '是否已读'
  }
}, {
  tableName: 'ai_suggestions',
  timestamps: true
});

module.exports = AISuggestion;
