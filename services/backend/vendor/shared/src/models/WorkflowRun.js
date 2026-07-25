/**
 * Workflow run (execution record) — the cross-process work queue.
 *
 * One row = one requested/in-progress/finished execution of a UserWorkflow.
 * ai-backend (REST, user page) INSERTs a `queued` row; services/backend (the
 * agent engine) polls for `queued` rows, atomically claims one (queued ->
 * running), executes the canvas graph natively, and writes back status + per-node
 * log. The two processes never call each other — this table is the only bridge.
 *
 * The graph is SNAPSHOTTED into `graph_json` at enqueue time, so editing the
 * source workflow afterwards never mutates an in-flight or historical run.
 *
 * HUMAN-IN-THE-LOOP: when execution hits an askUserQuestion node, the worker
 * persists a resume checkpoint (`pending_json` = the question + the saved cursor)
 * and parks the run at `awaiting_input`. The user answers via ai-backend, which
 * writes `resume_json` (the answer). The worker resumes from the checkpoint,
 * injecting the answer. Because pause/resume cross the process boundary, the
 * checkpoint lives in this row (the only bridge) — NOT in an in-memory registry.
 *
 * @pattern Active Record (work queue + durable checkpoint)
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const WorkflowRun = sequelize.define('WorkflowRun', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of the run (tenant scope)',
  },
  workflowId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'workflow_id',
    comment: 'Source UserWorkflow id',
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'queued',
    comment: 'queued | running | awaiting_input | succeeded | failed',
  },
  graphJson: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    field: 'graph_json',
    comment: 'Snapshot of the canvas graph at enqueue time',
    set(value) {
      this.setDataValue('graphJson', JSON.stringify(value == null ? {} : value));
    },
    get() {
      const raw = this.getDataValue('graphJson');
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    },
  },
  varsJson: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    field: 'vars_json',
    comment: 'Final variable bag produced by the run',
    set(value) {
      this.setDataValue('varsJson', JSON.stringify(value == null ? {} : value));
    },
    get() {
      const raw = this.getDataValue('varsJson');
      try { return JSON.parse(raw || '{}'); } catch { return {}; }
    },
  },
  logJson: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    field: 'log_json',
    comment: 'Ordered per-node execution log [{ nodeId, type, status, summary, ... }]',
    set(value) {
      this.setDataValue('logJson', JSON.stringify(Array.isArray(value) ? value : []));
    },
    get() {
      const raw = this.getDataValue('logJson');
      try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
    },
  },
  error: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Failure message when status = failed',
  },
  pendingJson: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'pending_json',
    comment: 'When awaiting_input: { nodeId, question, options, answerVar, cursor, vars } resume checkpoint',
    set(value) {
      this.setDataValue('pendingJson', value == null ? null : JSON.stringify(value));
    },
    get() {
      const raw = this.getDataValue('pendingJson');
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
  },
  resumeJson: {
    type: DataTypes.TEXT,
    allowNull: true,
    field: 'resume_json',
    comment: 'User-supplied answer for the parked askUserQuestion node: { answer }',
    set(value) {
      this.setDataValue('resumeJson', value == null ? null : JSON.stringify(value));
    },
    get() {
      const raw = this.getDataValue('resumeJson');
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
  },
  startedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'started_at',
    comment: 'When the worker claimed the run',
  },
  finishedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'finished_at',
    comment: 'When the run reached a terminal status',
  },
}, {
  tableName: 'workflow_runs',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['workflow_id'] },
    { fields: ['status'] },
  ],
});

module.exports = WorkflowRun;
