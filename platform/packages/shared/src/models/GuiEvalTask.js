/**
 * GUI Agent 评测任务模型（GuiEvalTask）
 *
 * 存储一个 GUI Agent 评测任务的完整定义：目标、环境配置、素材、Checkpoint、Gold 标准答案。
 * 关联：User 1:N GuiEvalTask，GuiEvalTask 1:N GuiEvalRun。
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const GuiEvalTask = sequelize.define('GuiEvalTask', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: '任务名称',
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '任务详细描述（给模型看的目标说明）',
  },
  difficulty: {
    type: DataTypes.ENUM('easy', 'medium', 'hard', 'expert'),
    defaultValue: 'medium',
    comment: '难度：easy / medium / hard / expert',
  },
  category: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: '任务分类（如 "OS", "Browser", "Office"）',
  },
  status: {
    type: DataTypes.ENUM('draft', 'active', 'archived', 'deprecated'),
    defaultValue: 'draft',
    comment: '状态：draft-草稿, active-启用, archived-归档, deprecated-废弃',
  },
  materials: {
    type: jsonType,
    defaultValue: [],
    comment: '任务素材（文件路径、URL、占位账号等）。示例：[{type:"file",path:"..."},{type:"account",username:"test",password:"1234"}]',
  },
  environment: {
    type: jsonType,
    defaultValue: {},
    comment: '环境要求（目标 OS、需要预装的软件、分辨率等）。示例：{os:"windows",apps:["notepad"],resolution:"1920x1080"}',
  },
  checkpoints: {
    type: jsonType,
    defaultValue: [],
    comment: '判分节点数组。每条：{id,type,description,weight,params}。type 可选值：screenshot_match|ui_element|file_created|file_content|process_running|semantic|custom_script',
  },
  gold_standard: {
    type: jsonType,
    defaultValue: {},
    comment: '标准答案 / 参考轨迹。结构同 recordingCollector 输出：{trajectory:[...],artifacts:[...],expectedResult:{...}}',
  },
  pricing: {
    type: jsonType,
    defaultValue: { basePrice: 320 },
    comment: '定价配置：{basePrice:320,difficultyMultipliers:{easy:0.5,medium:1,hard:2,expert:5},timeFactorDecay:{threshold:1.2,step:0.05,floor:0.3}}',
  },
  tags: {
    type: jsonType,
    defaultValue: [],
    comment: '标签数组，用于筛选和分类',
  },
  max_duration: {
    type: DataTypes.INTEGER,
    defaultValue: 300,
    comment: '单次执行最大时长（秒），默认 300s',
  },
  retry_allowed: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    comment: '是否允许重试',
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '创建者用户ID（sentinel 0 = 系统内置）',
  },
}, {
  tableName: 'gui_eval_tasks',
  timestamps: true,
  underscored: true,
});

module.exports = GuiEvalTask;
