/**
 * Web Frontend 轨迹标注任务模型（WebFrontendEvalTask）
 *
 * 存储一个 2D/3D Web 前端 AI 编码标注任务的完整定义。
 * 关联：User 1:N WebFrontendEvalTask，WebFrontendEvalTask 1:N WebFrontendEvalRun。
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

/**
 * @typedef {'L1'|'L2'|'L3'} Level
 * L1 = 静态展示 / L2 = 交互响应 / L3 = 复杂 3D / 物理 / 动画
 *
 * @typedef {'2d'|'3d'} Category
 * 2d = 2D Web 前端 / 3d = 3D Web 前端
 */

const WebFrontendEvalTask = sequelize.define('WebFrontendEvalTask', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  /** 任务名称 */
  name: {
    type: DataTypes.STRING(200),
    allowNull: false,
  },
  /** 任务描述（标注人员视角的说明） */
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  /** 层级：L1 / L2 / L3 */
  level: {
    type: DataTypes.ENUM('L1', 'L2', 'L3'),
    defaultValue: 'L1',
    comment: '任务层级：L1-静态展示, L2-交互响应, L3-复杂3D/物理/动画',
  },
  /** 分类：2d / 3d */
  category: {
    type: DataTypes.ENUM('2d', '3d'),
    defaultValue: '2d',
    comment: '分类：2d-2D Web 前端, 3d-3D Web 前端',
  },
  /** 状态 */
  status: {
    type: DataTypes.ENUM('draft', 'active', 'archived', 'deprecated'),
    defaultValue: 'draft',
    comment: '状态：draft-草稿, active-启用, archived-归档, deprecated-废弃',
  },
  /** 任务指令 prompt.md 的原始内容（给标注人员看的需求说明） */
  prompt_md: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '原始任务 prompt（用户视角 query，含约束/验收条件）',
  },
  /** 原始参考素材列表 */
  assets: {
    type: jsonType,
    defaultValue: [],
    comment: '参考素材：[{name,path,type,source,license}] — type: image/model/texture/hdri/audio, source: 来源说明, license: 授权说明',
  },
  /** 验收标准 */
  acceptance_criteria: {
    type: jsonType,
    defaultValue: [],
    comment: '验收标准数组：[{id, description, weight}]',
  },
  /** 素材根目录（相对或绝对路径） */
  assets_root: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: 'assets/ 目录在文件系统中的路径',
  },
  /** 标签 */
  tags: {
    type: jsonType,
    defaultValue: [],
    comment: '标签数组：["three.js", "blender", "shader", ...]',
  },
  /** 是否锁定依赖（true = 必须使用指定版本） */
  lock_dependencies: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    comment: '是否锁定依赖版本',
  },
  /** 创建者 */
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '创建者用户ID（sentinel 0 = 系统）',
  },
}, {
  tableName: 'web_frontend_eval_tasks',
  timestamps: true,
  underscored: true,
});

module.exports = WebFrontendEvalTask;
