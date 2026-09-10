'use strict';

describe('services/orchestrator/index', () => {
  it('should export criticalPathSchedule', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.criticalPathSchedule).toBeDefined();
  });

  it('should export dependencyWaveScheduler', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.dependencyWaveScheduler).toBeDefined();
  });

  it('should export mergeEmptySuccess', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.mergeEmptySuccess).toBeDefined();
  });

  it('should export mergeFileConflicts', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.mergeFileConflicts).toBeDefined();
  });

  it('should export mergeRoleAttribution', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.mergeRoleAttribution).toBeDefined();
  });

  it('should export orchestrationJournal', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.orchestrationJournal).toBeDefined();
  });

  it('should export orchestrationPlan', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.orchestrationPlan).toBeDefined();
  });

  it('should export orchestrationService', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.orchestrationService).toBeDefined();
  });

  it('should export roleToolScope', () => {
    const mod = require('../../../src/services/orchestrator');
    expect(mod.roleToolScope).toBeDefined();
  });
});
