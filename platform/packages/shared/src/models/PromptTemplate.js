/**
 * Per-user prompt template library (multi-tenant).
 *
 * One row = one saved prompt owned by a user. Prompts arrive two ways:
 *   - `source: 'manual'`     — the user explicitly saved a prompt they liked
 *     from the chat UI; lands `status: 'active'` (immediately in the library).
 *   - `source: 'ai_discovered'` — the chat stream auto-captured a prompt the
 *     heuristic judged worth keeping; lands `status: 'pending'` (a review queue)
 *     until the user confirms-keep (approve → active) or discards (delete).
 *
 * The prompt text itself (`content`) is the single source of truth. Carries no
 * model capabilities or runtime state — purely the editable prompt document
 * (zero-hardcoding rule). Field shape mirrors the file-based promptLibraryService
 * record ({title, content, category, tags, usedCount, lastUsedAt}) so a future
 * one-shot import from ~/.khyquant/prompts stays straightforward.
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const PromptTemplate = sequelize.define('PromptTemplate', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this prompt template',
  },
  title: {
    type: DataTypes.STRING(200),
    defaultValue: '未命名提示词',
    comment: 'Human-friendly prompt title (derived from content when omitted)',
  },
  content: {
    type: DataTypes.TEXT,
    allowNull: false,
    comment: 'The prompt text — single source of truth',
  },
  category: {
    type: DataTypes.STRING(80),
    allowNull: true,
    comment: 'Optional grouping label',
  },
  tags: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    comment: 'Free-form tags as a JSON array',
    set(value) {
      this.setDataValue('tags', JSON.stringify(Array.isArray(value) ? value : []));
    },
    get() {
      const raw = this.getDataValue('tags');
      try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  },
  source: {
    type: DataTypes.STRING(20),
    defaultValue: 'manual',
    comment: "How the prompt entered the library: 'manual' | 'ai_discovered'",
  },
  status: {
    type: DataTypes.STRING(20),
    defaultValue: 'active',
    comment: "Lifecycle: 'active' (in library) | 'pending' (awaiting user review)",
  },
  usedCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    field: 'used_count',
    comment: 'How many times the user has reused this prompt',
  },
  lastUsedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'last_used_at',
    comment: 'Timestamp of the most recent reuse',
  },
}, {
  tableName: 'prompt_templates',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['user_id', 'status'] },
  ],
});

module.exports = PromptTemplate;
