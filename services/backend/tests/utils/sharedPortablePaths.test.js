'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATABASE_MODULE = '../../../../platform/packages/shared/src/config/database';
const STORAGE_PATHS_MODULE = '../../../../platform/packages/shared/src/utils/storagePaths';

jest.mock('../../../../platform/packages/shared/src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('shared portable state paths', () => {
  const oldEnv = { ...process.env };
  let tempRoot;
  let database;
  let resolveLogDir;

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-shared-paths-'));
    process.env.NODE_ENV = 'production';
    process.env.DB_TYPE = 'sqlite';
    process.env.KHY_DATA_HOME = path.join(tempRoot, '.khy');
    delete process.env.KHY_APP_HOME;
    delete process.env.KHYQUANT_DATA_HOME;
    delete process.env.KHY_LOG_HOME;
    delete process.env.SQLITE_DB_PATH;
    delete process.env.DB_PATH;

    jest.resetModules();
    database = require(DATABASE_MODULE);
    ({ resolveLogDir } = require(STORAGE_PATHS_MODULE));
  });

  afterAll(async () => {
    if (database?.sequelize) {
      await database.sequelize.close().catch(() => {});
    }
    process.env = { ...oldEnv };
    jest.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.KHY_APP_HOME;
    process.env.KHY_DATA_HOME = path.join(tempRoot, '.khy');
    delete process.env.KHYQUANT_DATA_HOME;
    delete process.env.SQLITE_DB_PATH;
    delete process.env.DB_PATH;
  });

  test('SQLite defaults to the canonical portable data home', () => {
    expect(database.getSQLitePath()).toBe(path.join(
      path.resolve(process.env.KHY_DATA_HOME),
      'khyquant',
      'data',
      'khy-quant.db'
    ));
  });

  test('KHY_APP_HOME has precedence over canonical and legacy data homes', () => {
    process.env.KHY_APP_HOME = path.join(tempRoot, 'app-home');
    process.env.KHYQUANT_DATA_HOME = path.join(tempRoot, 'legacy-home');

    expect(database.getSQLitePath()).toBe(path.join(
      path.resolve(process.env.KHY_APP_HOME),
      'khyquant',
      'data',
      'khy-quant.db'
    ));
  });

  test('legacy data home remains a compatible fallback', () => {
    delete process.env.KHY_DATA_HOME;
    process.env.KHYQUANT_DATA_HOME = path.join(tempRoot, 'legacy-home');

    expect(database.getSQLitePath()).toBe(path.join(
      path.resolve(process.env.KHYQUANT_DATA_HOME),
      'khyquant',
      'data',
      'khy-quant.db'
    ));
  });

  test('explicit SQLite paths retain highest precedence', () => {
    process.env.DB_PATH = path.join(tempRoot, 'db-path.sqlite');
    process.env.SQLITE_DB_PATH = path.join(tempRoot, 'sqlite-db-path.sqlite');

    expect(database.getSQLitePath()).toBe(path.resolve(process.env.SQLITE_DB_PATH));
  });

  test('logger uses the canonical portable log directory', () => {
    expect(resolveLogDir()).toBe(path.join(path.resolve(process.env.KHY_DATA_HOME), 'logs'));
  });

  test('explicit log home wins and legacy data home remains compatible', () => {
    const legacyHome = path.join(tempRoot, 'legacy-log-home');
    const explicitLogHome = path.join(tempRoot, 'explicit-logs');
    const fallbackDir = path.join(tempRoot, 'fallback-logs');

    expect(resolveLogDir({ KHYQUANT_DATA_HOME: legacyHome }, fallbackDir)).toBe(
      path.join(path.resolve(legacyHome), 'logs')
    );
    expect(resolveLogDir({
      KHY_LOG_HOME: explicitLogHome,
      KHY_DATA_HOME: process.env.KHY_DATA_HOME,
    }, fallbackDir)).toBe(path.resolve(explicitLogHome));
  });
});
