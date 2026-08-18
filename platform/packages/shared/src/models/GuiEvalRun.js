/**
 * GUI Agent 评测执行记录模型（GuiEvalRun）
 *
 * 记录一次 GUI Agent 执行评测任务的完整运行数据：轨迹、产物、评分、结算。
 * 关联：GuiEvalTask 1:N GuiEvalRun，GuiEvalRun 1:N GuiEvalRunArtifact（可选）。
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const isSqlite = sequelize.getDialect && sequelize.getDialect() === 'sqlite';
const jsonType = isSqlite ? DataTypes.JSON : DataTypes.JSONB;

const GuiEvalRun = sequelize.define('GuiEvalRun', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  task_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: '关联评测任务ID',
  },
  guarded_run_id: {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: 'largeTasks guardedRun 追踪ID（用于关联大型任务执行链路）',
  },
  agent_model: {
    type: DataTypes.STRING(100),
    allowNull: true,
    comment: '使用的 Agent 模型标识（由模型单一真源中的角色或数组定义）',
  },
  agent_config: {
    type: jsonType,
    defaultValue: {},
    comment: 'Agent 运行配置（temperature, maxIterations 等）',
  },
  status: {
    type: DataTypes.ENUM('queued', 'preparing', 'running', 'evaluating', 'completed', 'failed', 'cancelled', 'timeout'),
    defaultValue: 'queued',
    comment: '状态：queued-排队, preparing-准备环境, running-执行中, evaluating-评测中, completed-完成, failed-失败, cancelled-取消, timeout-超时',
  },
  trajectory: {
    type: jsonType,
    defaultValue: [],
    comment: '操作轨迹（每步的 action + params + result + screenshotPath + timestamp）',
  },
  recordings: {
    type: jsonType,
    defaultValue: {},
    comment: '录制数据：{screenshots:[{step,path,sha256,timestamp}],trajectoryGraph:{...},screenRecording:"/path/to/video.mp4"}',
  },
  artifacts: {
    type: jsonType,
    defaultValue: [],
    comment: '产出物清单：[{path,sha256,size,type,description}]',
  },
  checkpoint_results: {
    type: jsonType,
    defaultValue: [],
    comment: '逐 Checkpoint 评测结果：[{checkpointId,passed,evidence,duration,autoScore}]',
  },
  overall_score: {
    type: DataTypes.DECIMAL(5, 4),
    allowNull: true,
    comment: '综合得分（0~1）',
  },
  auto_score: {
    type: DataTypes.DECIMAL(5, 4),
    allowNull: true,
    comment: '自动评测得分（0~1）',
  },
  manual_score: {
    type: DataTypes.DECIMAL(5, 4),
    allowNull: true,
    comment: '人工复核得分（0~1），null 表示未复核',
  },
  verdict: {
    type: DataTypes.ENUM('pending', 'pass', 'partial', 'fail', 'pending_review'),
    defaultValue: 'pending',
    comment: '最终判定：pending-待评测, pass-通过, partial-部分通过, fail-失败, pending_review-待人工复核',
  },
  discrepancies: {
    type: jsonType,
    defaultValue: [],
    comment: '与 Gold 标准的差异清单：[{checkpointId,expected,actual,severity:"minor"|"major"|"critical"}]',
  },
  payout_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    comment: '结算金额（元）',
  },
  pricing_breakdown: {
    type: jsonType,
    defaultValue: {},
    comment: '定价明细：{basePrice,difficultyMultiplier,completionRatio,timeFactor,finalPayout}',
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '错误信息（失败时填写）',
  },
  error_stack: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: '错误堆栈',
  },
  started_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: '开始执行时间',
  },
  completed_at: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: '完成时间',
  },
  total_duration: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '总耗时（秒）',
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: '触发执行的用户ID（sentinel 0 = 系统自动）',
  },
}, {
  tableName: 'gui_eval_runs',
  timestamps: true,
  underscored: true,
});

module.exports = GuiEvalRun;
