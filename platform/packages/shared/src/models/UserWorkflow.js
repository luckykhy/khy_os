/**
 * Per-user visual workflow (multi-tenant).
 *
 * One row = one drag-and-drop workflow owned by a user. The canvas graph
 * (nodes + connections) is the single source of truth, persisted verbatim as
 * JSON in `graph_json`; the Markdown export pipeline derives `.claude` skill /
 * agent artifacts from it (one-way). Carries no model capabilities or runtime
 * state — purely the editable graph document (zero-hardcoding rule).
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserWorkflow = sequelize.define('UserWorkflow', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this workflow',
  },
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
    comment: 'Human-friendly workflow name',
  },
  description: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    comment: 'Optional workflow description',
  },
  version: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
    comment: 'Bumped on every save',
  },
  graphJson: {
    type: DataTypes.TEXT,
    defaultValue: '{}',
    field: 'graph_json',
    comment: 'Canonical canvas graph { nodes, connections } (single source of truth)',
    set(value) {
      this.setDataValue('graphJson', JSON.stringify(value == null ? {} : value));
    },
    get() {
      const raw = this.getDataValue('graphJson');
      try {
        return JSON.parse(raw || '{}');
      } catch {
        return {};
      }
    },
  },
}, {
  tableName: 'user_workflows',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
  ],
});

module.exports = UserWorkflow;
