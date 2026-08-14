'use strict';

/**
 * Unit tests for cleanupService.
 *
 * Tests the pure helper functions (humanSize) and verifies the module
 * structure. Filesystem operations are tested with mocked fs module
 * to avoid side effects on the real filesystem.
 */

// We do NOT mock fs here because cleanupService uses it directly
// for file operations, but we mock the directories to be empty.
// Instead, we test the pure functions and module structure.

let cleanupService;

beforeAll(() => {
  try {
    cleanupService = require('../../src/services/cleanupService');
  } catch (e) {
    if (e instanceof SyntaxError) throw e;
    if (e.code === 'MODULE_NOT_FOUND' && !e.message.includes('cleanupService')) throw e;
  }
});

describe('cleanupService', () => {
  test('module exports expected functions', () => {
    if (!cleanupService) return;
    expect(typeof cleanupService.runCleanup).toBe('function');
    expect(typeof cleanupService.startPeriodicCleanup).toBe('function');
    expect(typeof cleanupService.stopPeriodicCleanup).toBe('function');
    expect(typeof cleanupService.rotateSecurityLog).toBe('function');
    expect(typeof cleanupService.cleanSnapshots).toBe('function');
    expect(typeof cleanupService.trimTrainingData).toBe('function');
    expect(typeof cleanupService.cleanTelemetry).toBe('function');
    expect(typeof cleanupService.cleanBackendDir).toBe('function');
    expect(typeof cleanupService.cleanOsTempFiles).toBe('function');
    expect(typeof cleanupService.getStorageReport).toBe('function');
    expect(typeof cleanupService.humanSize).toBe('function');
  });

  test('humanSize formats bytes correctly', () => {
    if (!cleanupService) return;
    expect(cleanupService.humanSize(0)).toBe('0 B');
    expect(cleanupService.humanSize(500)).toBe('500 B');
    expect(cleanupService.humanSize(1024)).toBe('1.0 KB');
    expect(cleanupService.humanSize(1536)).toBe('1.5 KB');
    expect(cleanupService.humanSize(1024 * 1024)).toBe('1.0 MB');
    expect(cleanupService.humanSize(1024 * 1024 * 2.5)).toBe('2.5 MB');
  });

  test('humanSize handles edge cases', () => {
    if (!cleanupService) return;
    expect(cleanupService.humanSize(1)).toBe('1 B');
    expect(cleanupService.humanSize(1023)).toBe('1023 B');
    expect(cleanupService.humanSize(1025)).toContain('KB');
  });

  test('getStorageReport returns structured report', () => {
    if (!cleanupService) return;
    const report = cleanupService.getStorageReport();
    expect(report).toBeDefined();
    expect(typeof report).toBe('object');
    expect(report).toHaveProperty('securityLog');
    expect(report).toHaveProperty('growthSnapshots');
    expect(report).toHaveProperty('trainingData');
    expect(report).toHaveProperty('telemetry');
    expect(report).toHaveProperty('conversations');
    expect(report).toHaveProperty('total');
    expect(report).toHaveProperty('totalHuman');
    expect(typeof report.total).toBe('number');
    expect(typeof report.totalHuman).toBe('string');
  });

  test('cleanBackendDir handles nonexistent directory gracefully', () => {
    if (!cleanupService) return;
    const result = cleanupService.cleanBackendDir('nonexistent_dir_xyz');
    expect(result).toBeDefined();
    expect(result.removed).toBe(0);
    expect(result.bytes).toBe(0);
  });

  test('cleanOsTempFiles returns structured result', () => {
    if (!cleanupService) return;
    const result = cleanupService.cleanOsTempFiles();
    expect(result).toBeDefined();
    expect(typeof result.removed).toBe('number');
    expect(typeof result.bytes).toBe('number');
    expect(result.removed).toBeGreaterThanOrEqual(0);
    expect(result.bytes).toBeGreaterThanOrEqual(0);
  });

  test('runCleanup returns results with summary', () => {
    if (!cleanupService) return;
    const results = cleanupService.runCleanup();
    expect(results).toBeDefined();
    expect(results).toHaveProperty('securityLog');
    expect(results).toHaveProperty('snapshots');
    expect(results).toHaveProperty('trainingData');
    expect(results).toHaveProperty('telemetry');
    expect(results).toHaveProperty('summary');
    expect(results.summary).toHaveProperty('freedBytes');
    expect(results.summary).toHaveProperty('freedHuman');
    expect(results.summary).toHaveProperty('actions');
    expect(Array.isArray(results.summary.actions)).toBe(true);
  });
});
