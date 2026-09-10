'use strict';

const orchestrator = require('../../src/services/orchestrator/index');

describe('orchestrator index', () => {
  test('module is defined', () => {
    expect(orchestrator).toBeDefined();
  });

  test('exports criticalPathSchedule', () => {
    expect(orchestrator.criticalPathSchedule).toBeDefined();
  });

  test('exports dependencyWaveScheduler', () => {
    expect(orchestrator.dependencyWaveScheduler).toBeDefined();
  });

  test('exports mergeEmptySuccess', () => {
    expect(orchestrator.mergeEmptySuccess).toBeDefined();
  });

  test('exports mergeFileConflicts', () => {
    expect(orchestrator.mergeFileConflicts).toBeDefined();
  });

  test('exports mergeRoleAttribution', () => {
    expect(orchestrator.mergeRoleAttribution).toBeDefined();
  });

  test('exports orchestrationJournal', () => {
    expect(orchestrator.orchestrationJournal).toBeDefined();
  });

  test('exports orchestrationPlan', () => {
    expect(orchestrator.orchestrationPlan).toBeDefined();
  });

  test('exports orchestrationService', () => {
    expect(orchestrator.orchestrationService).toBeDefined();
  });

  test('exports roleToolScope', () => {
    expect(orchestrator.roleToolScope).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof orchestrator.criticalPathSchedule).toBe('object');
    expect(typeof orchestrator.dependencyWaveScheduler).toBe('object');
    expect(typeof orchestrator.mergeEmptySuccess).toBe('object');
    expect(typeof orchestrator.mergeFileConflicts).toBe('object');
    expect(typeof orchestrator.mergeRoleAttribution).toBe('object');
    expect(typeof orchestrator.orchestrationJournal).toBe('object');
    expect(typeof orchestrator.orchestrationPlan).toBe('object');
    expect(typeof orchestrator.orchestrationService).toBe('object');
    expect(typeof orchestrator.roleToolScope).toBe('object');
  });
});

