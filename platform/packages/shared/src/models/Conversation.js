/**
 * Per-user AI chat conversation (multi-tenant).
 *
 * One row = one persisted Web chat session owned by a user. The full message
 * transcript is the single source of truth, stored verbatim as a JSON array in
 * `messages` (TEXT, JSON get/set). The sidebar list view reads only lightweight
 * projected fields (title + timestamps + counts); the transcript is fetched on
 * demand when a conversation is opened. Carries no model capabilities or runtime
 * state — purely the editable chat document (zero-hardcoding rule).
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Conversation = sequelize.define('Conversation', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this conversation',
  },
  projectId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    field: 'project_id',
    comment: 'Optional owning coding project (UserProject.id); null = ungrouped, always visible',
  },
  title: {
    type: DataTypes.STRING(200),
    defaultValue: '新对话',
    comment: 'Human-friendly conversation title (derived from first user message)',
  },
  messages: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    comment: 'Canonical chat transcript as a JSON array (single source of truth)',
    set(value) {
      this.setDataValue('messages', JSON.stringify(Array.isArray(value) ? value : []));
    },
    get() {
      const raw = this.getDataValue('messages');
      try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  },
}, {
  tableName: 'ai_conversations',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['project_id'] },
  ],
});

module.exports = Conversation;
