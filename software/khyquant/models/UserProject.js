/**
 * Per-user coding Project (named multi-folder workspace, multi-tenant).
 *
 * One row = one human-named workspace owned by a user, aligning to Hermes v0.18.0
 * desktop "coding projects" (a named, persisted entity anchoring one or more
 * folders). Unlike a raw session cwd, a Project is an explicit label the user
 * creates; conversations opt into a Project via `Conversation.project_id`, and
 * the chat sidebar filters by the active Project.
 *
 * Web boundary (differs from Hermes desktop): there is no local process cwd to
 * move, so `folders` / `primaryPath` are string anchors only — grouping labels,
 * never an executed `cd`. Carries no model capabilities or runtime state — purely
 * the editable workspace document (zero-hardcoding rule).
 *
 * @pattern Strategy
 */
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserProject = sequelize.define('UserProject', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: 'Owner of this project',
  },
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
    comment: 'Human-friendly project name',
  },
  description: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    comment: 'Optional project description',
  },
  icon: {
    type: DataTypes.STRING(32),
    defaultValue: '',
    comment: 'Optional icon/emoji label for the sidebar',
  },
  color: {
    type: DataTypes.STRING(32),
    defaultValue: '',
    comment: 'Optional accent color (hex or token)',
  },
  primaryPath: {
    type: DataTypes.STRING(500),
    defaultValue: '',
    field: 'primary_path',
    comment: 'Primary folder anchor (string label only; no executed cd)',
  },
  folders: {
    type: DataTypes.TEXT,
    defaultValue: '[]',
    comment: 'Additional folder anchors as a JSON array (single source of truth)',
    set(value) {
      this.setDataValue('folders', JSON.stringify(Array.isArray(value) ? value : []));
    },
    get() {
      const raw = this.getDataValue('folders');
      try {
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },
  },
  archived: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'Archived projects are hidden from the default list but not deleted',
  },
}, {
  tableName: 'user_projects',
  timestamps: true,
  indexes: [
    { fields: ['user_id'] },
  ],
});

module.exports = UserProject;
