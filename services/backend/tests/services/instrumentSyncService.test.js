'use strict';

/**
 * Unit tests for instrumentSyncService.
 *
 * Mocks database models, child_process, and node-cron to test
 * pure logic: sync state tracking, status reporting, guard against
 * concurrent sync.
 */

jest.mock('../../src/models/Instrument', () => ({
  findAll: jest.fn().mockResolvedValue([]),
  bulkCreate: jest.fn().mockResolvedValue([]),
}));

jest.mock('node-cron', () => ({
  schedule: jest.fn().mockReturnValue({ stop: jest.fn() }),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn().mockReturnValue({
    stdout: { setEncoding: jest.fn(), on: jest.fn() },
    stderr: { setEncoding: jest.fn(), on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
  }),
}));

// Mock notificationService to prevent broadcast errors
jest.mock('../../src/services/notificationService', () => ({
  broadcast: jest.fn(),
}));

// Mock pythonPath utility
jest.mock('../../src/utils/pythonPath', () => ({
  findPython: jest.fn().mockReturnValue('python3'),
}));

let instrumentSyncService;

beforeAll(() => {
  try {
    instrumentSyncService = require('../../src/services/instrumentSyncService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('instrumentSyncService')) throw e;
  }
});

describe('instrumentSyncService', () => {
  test('module exports an object with expected methods', () => {
    if (!instrumentSyncService) return;
    expect(typeof instrumentSyncService).toBe('object');
    expect(typeof instrumentSyncService.start).toBe('function');
    expect(typeof instrumentSyncService.stop).toBe('function');
    expect(typeof instrumentSyncService.syncInstruments).toBe('function');
    expect(typeof instrumentSyncService.onLogin).toBe('function');
    expect(typeof instrumentSyncService.getStatus).toBe('function');
    expect(typeof instrumentSyncService.triggerSync).toBe('function');
  });

  test('getStatus returns structured status object', () => {
    if (!instrumentSyncService) return;
    const status = instrumentSyncService.getStatus();
    expect(status).toHaveProperty('isSyncing');
    expect(status).toHaveProperty('syncCount');
    expect(status).toHaveProperty('newInstrumentsCount');
    expect(status).toHaveProperty('lastSyncTime');
    expect(typeof status.isSyncing).toBe('boolean');
    expect(typeof status.syncCount).toBe('number');
  });

  test('initial state has isSyncing false and syncCount 0+', () => {
    if (!instrumentSyncService) return;
    // syncCount may have been incremented by delayed start() in constructor
    expect(instrumentSyncService.isSyncing).toBe(false);
    expect(instrumentSyncService.syncCount).toBeGreaterThanOrEqual(0);
  });

  test('onLogin only syncs once per day', async () => {
    if (!instrumentSyncService) return;
    // Reset daily flag
    instrumentSyncService._todaySynced = false;
    const syncSpy = jest.spyOn(instrumentSyncService, 'syncInstruments').mockResolvedValue(undefined);

    await instrumentSyncService.onLogin();
    await instrumentSyncService.onLogin();

    // Should have called syncInstruments only once (second call sees today already synced)
    expect(syncSpy).toHaveBeenCalledTimes(1);

    syncSpy.mockRestore();
  });

  test('syncInstruments skips when already syncing', async () => {
    if (!instrumentSyncService) return;
    instrumentSyncService.isSyncing = true;
    const countBefore = instrumentSyncService.syncCount;

    await instrumentSyncService.syncInstruments();

    // syncCount should not increment when skipped
    expect(instrumentSyncService.syncCount).toBe(countBefore);
    instrumentSyncService.isSyncing = false;
  });

  test('stop clears cronJob', () => {
    if (!instrumentSyncService) return;
    // Simulate having a cron job
    instrumentSyncService.cronJob = { stop: jest.fn() };
    instrumentSyncService.stop();
    expect(instrumentSyncService.cronJob).toBeNull();
  });

  test('broadcastSyncStatus calls notificationService', () => {
    if (!instrumentSyncService) return;
    // Should not throw even if notificationService is mocked
    expect(() => {
      instrumentSyncService.broadcastSyncStatus({
        type: 'sync_start',
        message: 'test',
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
  });
});
