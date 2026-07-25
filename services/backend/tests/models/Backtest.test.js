/**
 * Unit tests for Backtest model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const Backtest = require('../../src/models/Backtest');

describe('Backtest model', () => {
  test('exports a truthy value', () => {
    expect(Backtest).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(Backtest.tableName).toBeDefined();
  });

  test('table name is "backtests"', () => {
    expect(Backtest.tableName).toBe('backtests');
  });

  test('has rawAttributes defined', () => {
    expect(Backtest.rawAttributes).toBeDefined();
    expect(typeof Backtest.rawAttributes).toBe('object');
  });

  test('rawAttributes includes user_id field', () => {
    expect(Backtest.rawAttributes.user_id).toBeDefined();
  });

  test('rawAttributes includes strategy_id field', () => {
    expect(Backtest.rawAttributes.strategy_id).toBeDefined();
  });

  test('rawAttributes includes name field', () => {
    expect(Backtest.rawAttributes.name).toBeDefined();
  });

  test('rawAttributes includes status field', () => {
    expect(Backtest.rawAttributes.status).toBeDefined();
  });

  test('rawAttributes includes initialCapital field', () => {
    expect(Backtest.rawAttributes.initialCapital).toBeDefined();
  });

  test('rawAttributes includes totalReturn field', () => {
    expect(Backtest.rawAttributes.totalReturn).toBeDefined();
  });
});
