/**
 * 渠道 API 记录模型（ChannelApi）
 *
 * 记录一条 AI 渠道接入凭证：渠道名、供应商、端点 URL、API Key、环境变量名、
 * 配置方式与配置示例。渠道清单是系统级注册表（不归属单个用户），供网页端
 * 「渠道 API」板块 CRUD 与各 Agent 渠道配置指南共用。
 *
 * `api_key` 存的是 AES-256-GCM 密文（services/channelApiCrypto.js），明文永不落库，
 * 只在 channelApiService.revealChannelKey 中一次性返回并写审计日志。
 *
 * 建表方式：与 GuiEvalTask / WebFrontendEvalTask 一致，由 server.js 启动时的
 * sequelize.sync() 自动 CREATE TABLE IF NOT EXISTS，无需 DDL 迁移文件。
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ChannelApi = sequelize.define('ChannelApi', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  channel_name: {
    type: DataTypes.STRING(120),
    allowNull: false,
    comment: '渠道名称（如 "Claude Code"、"CommandCode"）',
  },
  provider: {
    type: DataTypes.STRING(80),
    allowNull: false,
    comment: '供应商（如 "Anthropic"、"OpenAI"、"自定义"）',
  },
  endpoint_url: {
    type: DataTypes.STRING(500),
    allowNull: false,
    comment: 'API 端点 URL（空串表示由使用方填写）',
  },
  api_key: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '',
    comment: 'AES-256-GCM 加密后的 API Key；空串表示尚未填写',
  },
  key_env_var: {
    type: DataTypes.STRING(120),
    allowNull: true,
    comment: '环境变量名（如 "ANTHROPIC_API_KEY"）',
  },
  config_method: {
    type: DataTypes.ENUM('env_var', 'config_file', 'both'),
    allowNull: false,
    defaultValue: 'env_var',
    comment: '配置方式：env_var-环境变量, config_file-配置文件, both-两者皆可',
  },
  config_snippet: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '配置示例代码块（Shell / JSON / YAML / TOML 纯文本，不含围栏）',
  },
  docs_url: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: '官方文档链接',
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '备注',
  },
}, {
  tableName: 'channel_apis',
  timestamps: true,
  underscored: true,
});

module.exports = ChannelApi;
