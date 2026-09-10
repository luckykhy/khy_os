'use strict';

describe('services/restore/index', () => {
  it('should export agentRestorePlan', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.agentRestorePlan).toBeDefined();
  });

  it('should export hydrationHealth', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.hydrationHealth).toBeDefined();
  });

  it('should export installIntegrity', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.installIntegrity).toBeDefined();
  });

  it('should export restoreConflictDetector', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.restoreConflictDetector).toBeDefined();
  });

  it('should export restoreConflictResolver', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.restoreConflictResolver).toBeDefined();
  });

  it('should export restoreConvergenceVerifier', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.restoreConvergenceVerifier).toBeDefined();
  });

  it('should export restoreReadiness', () => {
    const mod = require('../../../src/services/restore');
    expect(mod.restoreReadiness).toBeDefined();
  });
});
