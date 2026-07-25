/**
 * Compatibility shim — re-exports shared models and augments them with
 * backend-local auth state/session models.
 */
const sharedModels = require('@khy/shared/models');
const AuthSession = require('./AuthSession');
const UserAuthState = require('./UserAuthState');

if (sharedModels.User && !sharedModels.User.associations?.authSessions) {
  sharedModels.User.hasMany(AuthSession, {
    foreignKey: 'user_id',
    as: 'authSessions',
    constraints: false,
  });
}

if (!AuthSession.associations?.user) {
  AuthSession.belongsTo(sharedModels.User, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });
}

if (sharedModels.User && !sharedModels.User.associations?.authState) {
  sharedModels.User.hasOne(UserAuthState, {
    foreignKey: 'user_id',
    as: 'authState',
    constraints: false,
  });
}

if (!UserAuthState.associations?.user) {
  UserAuthState.belongsTo(sharedModels.User, {
    foreignKey: 'user_id',
    as: 'user',
    constraints: false,
  });
}

module.exports = {
  ...sharedModels,
  AuthSession,
  UserAuthState,
};
