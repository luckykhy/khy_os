/**
 * Unit tests for Trade model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const Trade = require('../../src/models/Trade');

describe('Trade model', () => {
  test('exports a truthy value', () => {
    expect(Trade).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(Trade.tableName).toBeDefined();
  });

  test('table name is "trades"', () => {
    expect(Trade.tableName).toBe('trades');
  });

  test('has rawAttributes defined', () => {
    expect(Trade.rawAttributes).toBeDefined();
    expect(typeof Trade.rawAttributes).toBe('object');
  });

  test('rawAttributes includes user_id field', () => {
    expect(Trade.rawAttributes.user_id).toBeDefined();
  });

  test('rawAttributes includes symbol field', () => {
    expect(Trade.rawAttributes.symbol).toBeDefined();
  });

  test('rawAttributes includes side field', () => {
    expect(Trade.rawAttributes.side).toBeDefined();
  });

  test('rawAttributes includes price field', () => {
    expect(Trade.rawAttributes.price).toBeDefined();
  });

  test('rawAttributes includes quantity field', () => {
    expect(Trade.rawAttributes.quantity).toBeDefined();
  });

  test('rawAttributes includes status field', () => {
    expect(Trade.rawAttributes.status).toBeDefined();
  });
});
