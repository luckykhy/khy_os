/**
 * Unit tests for Signal model module.
 */

jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const Signal = require('../../src/models/Signal');

describe('Signal model', () => {
  test('exports a truthy value', () => {
    expect(Signal).toBeTruthy();
  });

  test('is a Sequelize model with tableName', () => {
    expect(Signal.tableName).toBeDefined();
  });

  test('table name is "signals"', () => {
    expect(Signal.tableName).toBe('signals');
  });

  test('has rawAttributes defined', () => {
    expect(Signal.rawAttributes).toBeDefined();
    expect(typeof Signal.rawAttributes).toBe('object');
  });

  test('rawAttributes includes userId field', () => {
    expect(Signal.rawAttributes.userId).toBeDefined();
  });

  test('rawAttributes includes symbol field', () => {
    expect(Signal.rawAttributes.symbol).toBeDefined();
  });

  test('rawAttributes includes signal field', () => {
    expect(Signal.rawAttributes.signal).toBeDefined();
  });

  test('rawAttributes includes confidence field', () => {
    expect(Signal.rawAttributes.confidence).toBeDefined();
  });

  test('rawAttributes includes source field', () => {
    expect(Signal.rawAttributes.source).toBeDefined();
  });
});
