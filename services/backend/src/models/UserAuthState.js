const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const UserAuthState = sequelize.define('UserAuthState', {
  userId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    allowNull: false,
    field: 'user_id',
  },
  tokenInvalidBefore: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'token_invalid_before',
  },
  lastPasswordChangedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    field: 'last_password_changed_at',
  },
  lastInvalidationReason: {
    type: DataTypes.STRING(120),
    allowNull: true,
    field: 'last_invalidation_reason',
  },
}, {
  tableName: 'user_auth_states',
  timestamps: true,
  indexes: [
    { fields: ['token_invalid_before'] },
  ],
});

module.exports = UserAuthState;
