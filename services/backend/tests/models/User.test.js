/**
 * Unit tests for User model module.
 *
 * These tests validate the model file structure without requiring
 * a live database connection. DB-related errors during require()
 * are expected and tolerated.
 */

// Mock the database connection before any model imports
jest.mock('@khy/shared/config/database', () => {
  const { Sequelize } = require('sequelize');
  const sequelize = new Sequelize({ dialect: 'sqlite', dialectModule: require('@khy/shared/config/sqliteCompat'), storage: ':memory:', logging: false });
  return { sequelize, initDatabase: jest.fn() };
});

const User = require('../../src/models/User');

describe('User model', () => {
  test('exports a truthy value', () => {
    expect(User).toBeTruthy();
  });

  test('is a Sequelize model (has init or tableName)', () => {
    // Sequelize models created with sequelize.define() have a tableName property
    expect(User.tableName).toBeDefined();
  });

  test('table name is "users"', () => {
    expect(User.tableName).toBe('users');
  });

  test('has rawAttributes defined', () => {
    expect(User.rawAttributes).toBeDefined();
    expect(typeof User.rawAttributes).toBe('object');
  });

  test('rawAttributes includes username field', () => {
    expect(User.rawAttributes.username).toBeDefined();
  });

  test('rawAttributes includes email field', () => {
    expect(User.rawAttributes.email).toBeDefined();
  });

  test('rawAttributes includes password field', () => {
    expect(User.rawAttributes.password).toBeDefined();
  });

  test('rawAttributes includes role field', () => {
    expect(User.rawAttributes.role).toBeDefined();
  });

  test('rawAttributes includes status field', () => {
    expect(User.rawAttributes.status).toBeDefined();
  });

  test('has prototype methods for password comparison', () => {
    expect(typeof User.prototype.comparePassword).toBe('function');
  });
});
