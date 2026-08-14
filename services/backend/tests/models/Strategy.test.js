/**
 * Unit tests for Strategy model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const Strategy = require('../../src/models/Strategy');

describe('Strategy model', () => {
  test('exports a truthy value', () => {
    expect(Strategy).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(Strategy.tableName).toBeDefined();
  });

  test('table name is "strategies"', () => {
    expect(Strategy.tableName).toBe('strategies');
  });

  test('has rawAttributes defined', () => {
    expect(Strategy.rawAttributes).toBeDefined();
    expect(typeof Strategy.rawAttributes).toBe('object');
  });

  test('rawAttributes includes name field', () => {
    expect(Strategy.rawAttributes.name).toBeDefined();
  });

  test('rawAttributes includes description field', () => {
    expect(Strategy.rawAttributes.description).toBeDefined();
  });

  test('rawAttributes includes code field', () => {
    expect(Strategy.rawAttributes.code).toBeDefined();
  });

  test('rawAttributes includes user_id field', () => {
    expect(Strategy.rawAttributes.user_id).toBeDefined();
  });

  test('rawAttributes includes status field', () => {
    expect(Strategy.rawAttributes.status).toBeDefined();
  });

  test('rawAttributes includes language field', () => {
    expect(Strategy.rawAttributes.language).toBeDefined();
  });
});
