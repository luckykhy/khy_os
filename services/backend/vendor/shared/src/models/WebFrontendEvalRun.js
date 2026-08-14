/**
 * Web Frontend 轨迹标注执行记录模型（WebFrontendEvalRun）
 *
 * 记录一次标注任务的完整执行数据，包括 API 轨迹、产物路径、QC 结果。
 * 关联：WebFrontendEvalTask 1:N WebFrontendEvalRun。
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const WebFrontendEvalRun = sequelize.define('WebFrontendEvalRun', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  task_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '关联任务ID',
  },
  /** 轨迹包根目录（zip 文件路径或解压后的目录路径） */
  package_path: {
    type: DataTypes.STRING(1000),
    allowNull: true,
    comment: '轨迹包目录路径（解压后的 <task_id>/）',
  },
  /** 轨迹包是否已打包为 zip */
  package_zipped: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: '是否已打包为 zip 文件',
  },
  /** 使用的 AI 模型 */
  ai_model: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: '使用的 AI 模型（如 "claude-sonnet-4"）',
  },
  /** 标注人员 ID */
  annotator_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '标注人员用户ID',
  },
  /** API 调用轮次 */
  api_call_rounds: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'API 调用总轮次',
  },
  /** 状态 */
  status: {
    type: DataTypes.ENUM('draft', 'annotating', 'reviewing', 'completed', 'rejected', 'archived'),
    defaultValue: 'draft',
    comment: '状态：draft-草稿, annotating-标注中, reviewing-审核中, completed-完成, rejected-驳回, archived-归档',
  },
  /** 校验结果 */
  qc_result: {
    type: jsonType,
    defaultValue: null,
    comment: 'QC 结果：{passed:bool, score:float, defects:[], verdict:"pass"|"fail"|"needs_rework"}',
  },
  /** QC 评分（0~1） */
  qc_score: {
    type: DataTypes.DECIMAL(5, 4),
    allowNull: true,
    comment: 'QC 评分 0~1',
  },
  /** 自检清单完成情况 */
  self_check: {
    type: jsonType,
    defaultValue: null,
    comment: '自检清单：{items:[{key,passed,note}], completedAt}',
  },
  /** 标注备注 */
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '标注人员备注',
  },
  /** 驳回原因（status=rejected 时填写） */
  rejection_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '驳回原因',
  },
  /** 交付时间 */
  delivered_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: '交付时间',
  },
  /** 总耗时（秒） */
  total_duration: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '总耗时（秒）',
  },
}, {
  tableName: 'web_frontend_eval_runs',
  timestamps: true,
  underscored: true,
});

module.exports = WebFrontendEvalRun;
