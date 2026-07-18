/**
 * Unit tests for Instrument model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const Instrument = require('../../src/models/Instrument');

describe('Instrument model', () => {
  test('exports a truthy value', () => {
    expect(Instrument).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(Instrument.tableName).toBeDefined();
  });

  test('table name is "instruments"', () => {
    expect(Instrument.tableName).toBe('instruments');
  });

  test('has rawAttributes defined', () => {
    expect(Instrument.rawAttributes).toBeDefined();
    expect(typeof Instrument.rawAttributes).toBe('object');
  });

  test('rawAttributes includes symbol field', () => {
    expect(Instrument.rawAttributes.symbol).toBeDefined();
  });

  test('rawAttributes includes name field', () => {
    expect(Instrument.rawAttributes.name).toBeDefined();
  });

  test('rawAttributes includes type field', () => {
    expect(Instrument.rawAttributes.type).toBeDefined();
  });

  test('rawAttributes includes market field', () => {
    expect(Instrument.rawAttributes.market).toBeDefined();
  });

  test('rawAttributes includes status field', () => {
    expect(Instrument.rawAttributes.status).toBeDefined();
  });
});
