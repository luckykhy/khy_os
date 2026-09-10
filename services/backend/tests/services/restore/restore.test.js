'use strict';

const restore = require('../../src/services/restore/index');

describe('restore index', () => {
  test('module is defined', () => {
    expect(restore).toBeDefined();
  });

  test('exports agentRestorePlan', () => {
    expect(restore.agentRestorePlan).toBeDefined();
  });

  test('exports hydrationHealth', () => {
    expect(restore.hydrationHealth).toBeDefined();
  });

  test('exports installIntegrity', () => {
    expect(restore.installIntegrity).toBeDefined();
  });

  test('exports restoreConflictDetector', () => {
    expect(restore.restoreConflictDetector).toBeDefined();
  });

  test('exports restoreConflictResolver', () => {
    expect(restore.restoreConflictResolver).toBeDefined();
  });

  test('exports restoreConvergenceVerifier', () => {
    expect(restore.restoreConvergenceVerifier).toBeDefined();
  });

  test('exports restoreReadiness', () => {
    expect(restore.restoreReadiness).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof restore.agentRestorePlan).toBe('object');
    expect(typeof restore.hydrationHealth).toBe('object');
    expect(typeof restore.installIntegrity).toBe('object');
    expect(typeof restore.restoreConflictDetector).toBe('object');
    expect(typeof restore.restoreConflictResolver).toBe('object');
    expect(typeof restore.restoreConvergenceVerifier).toBe('object');
    expect(typeof restore.restoreReadiness).toBe('object');
  });
});

