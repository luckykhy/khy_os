'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('dbAutoMigration', () => {
  const originalEnv = { ...process.env };
  let tempDir = null;
  let stateFile = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-db-auto-migrate-'));
    stateFile = path.join(tempDir, 'db_migration_state.json');
    process.env.KHY_DB_MIGRATION_STATE_FILE = stateFile;
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
    stateFile = null;
  });

  test('skips when auto migration is disabled', async () => {
    process.env.KHY_AUTO_DB_MIGRATE = 'false';

    const { runAutoDbMigration } = require('../src/bootstrap/dbAutoMigration');
    const result = await runAutoDbMigration({ silent: true, reason: 'jest-disabled' });

    expect(result.ran).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  test('runs migration and persists state when forced', async () => {
    const ensureBaseTables = jest.fn().mockResolvedValue(undefined);
    const migrate = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../scripts/seed', () => ({ ensureBaseTables, migrate }));

    const { runAutoDbMigration } = require('../src/bootstrap/dbAutoMigration');
    const result = await runAutoDbMigration({ silent: true, force: true, reason: 'jest-force' });

    expect(result.ran).toBe(true);
    expect(ensureBaseTables).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(stateFile)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    expect(saved.lastMigratedVersion).toBeTruthy();
    expect(Array.isArray(saved.history)).toBe(true);
    expect(saved.history[saved.history.length - 1].reason).toBe('jest-force');
  });
});

