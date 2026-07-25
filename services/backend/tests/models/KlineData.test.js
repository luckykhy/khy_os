/**
 * Unit tests for KlineData model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const KlineData = require('../../src/models/KlineData');

describe('KlineData model', () => {
  test('exports a truthy value', () => {
    expect(KlineData).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(KlineData.tableName).toBeDefined();
  });

  test('table name is "kline_data"', () => {
    expect(KlineData.tableName).toBe('kline_data');
  });

  test('has rawAttributes defined', () => {
    expect(KlineData.rawAttributes).toBeDefined();
    expect(typeof KlineData.rawAttributes).toBe('object');
  });

  test('rawAttributes includes symbol field', () => {
    expect(KlineData.rawAttributes.symbol).toBeDefined();
  });

  test('rawAttributes includes period field', () => {
    expect(KlineData.rawAttributes.period).toBeDefined();
  });

  test('rawAttributes includes open_price field', () => {
    expect(KlineData.rawAttributes.open_price).toBeDefined();
  });

  test('rawAttributes includes close_price field', () => {
    expect(KlineData.rawAttributes.close_price).toBeDefined();
  });

  test('rawAttributes includes volume field', () => {
    expect(KlineData.rawAttributes.volume).toBeDefined();
  });

  test('rawAttributes includes trade_date field', () => {
    expect(KlineData.rawAttributes.trade_date).toBeDefined();
  });
});
