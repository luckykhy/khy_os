/**
 * Unit tests for ApiKey model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const ApiKey = require('../../src/models/ApiKey');

describe('ApiKey model', () => {
  test('exports a truthy value', () => {
    expect(ApiKey).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(ApiKey.tableName).toBeDefined();
  });

  test('table name is "api_keys"', () => {
    expect(ApiKey.tableName).toBe('api_keys');
  });

  test('has rawAttributes defined', () => {
    expect(ApiKey.rawAttributes).toBeDefined();
    expect(typeof ApiKey.rawAttributes).toBe('object');
  });

  test('rawAttributes includes userId field', () => {
    expect(ApiKey.rawAttributes.userId).toBeDefined();
  });

  test('rawAttributes includes keyHash field', () => {
    expect(ApiKey.rawAttributes.keyHash).toBeDefined();
  });

  test('rawAttributes includes keyPrefix field', () => {
    expect(ApiKey.rawAttributes.keyPrefix).toBeDefined();
  });

  test('rawAttributes includes label field', () => {
    expect(ApiKey.rawAttributes.label).toBeDefined();
  });

  test('rawAttributes includes isActive field', () => {
    expect(ApiKey.rawAttributes.isActive).toBeDefined();
  });
});
