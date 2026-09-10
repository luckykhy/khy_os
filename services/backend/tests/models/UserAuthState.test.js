'use strict';

const UserAuthState = require('../../src/models/UserAuthState');

describe('UserAuthState', () => {
  test('module exports a Sequelize model', () => {
    expect(UserAuthState).toBeDefined();
    expect(typeof UserAuthState).toBe('object');
  });

  test('model has correct tableName', () => {
    expect(UserAuthState.tableName).toBe('user_auth_states');
  });

  test('model has primaryKey defined', () => {
    expect(UserAuthState.primaryKeyAttribute).toBe('userId');
  });

  test('model has expected attributes', () => {
    const attributes = UserAuthState.rawAttributes;
    expect(attributes).toHaveProperty('userId');
    expect(attributes).toHaveProperty('tokenInvalidBefore');
    expect(attributes).toHaveProperty('lastPasswordChangedAt');
    expect(attributes).toHaveProperty('lastInvalidationReason');
  });

  test('userId field is allowNull false', () => {
    expect(UserAuthState.rawAttributes.userId.allowNull).toBe(false);
  });

  test('tokenInvalidBefore field is allowNull true', () => {
    expect(UserAuthState.rawAttributes.tokenInvalidBefore.allowNull).toBe(true);
  });

  test('lastPasswordChangedAt field is allowNull true', () => {
    expect(UserAuthState.rawAttributes.lastPasswordChangedAt.allowNull).toBe(true);
  });

  test('lastInvalidationReason field is allowNull true', () => {
    expect(UserAuthState.rawAttributes.lastInvalidationReason.allowNull).toBe(true);
  });

  test('model has timestamps enabled', () => {
    expect(UserAuthState.options.timestamps).toBe(true);
  });

  test('model has index on token_invalid_before', () => {
    const indexes = UserAuthState.options.indexes;
    expect(indexes).toBeDefined();
    expect(Array.isArray(indexes).toBe(true);
    const tokenIndex = indexes.find((idx) => idx.fields && idx.fields.includes('token_invalid_before'));
    expect(tokenIndex).toBeDefined();
  });
});

