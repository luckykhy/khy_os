'use strict';

describe('services/externalApps/index', () => {
  it('should export appModelImporter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.appModelImporter).toBeDefined();
  });

  it('should export claudeCodeAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.claudeCodeAdapter).toBeDefined();
  });

  it('should export commandCodeAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.commandCodeAdapter).toBeDefined();
  });

  it('should export cozeAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.cozeAdapter).toBeDefined();
  });

  it('should export deepseekTuiAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.deepseekTuiAdapter).toBeDefined();
  });

  it('should export geminiCliAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.geminiCliAdapter).toBeDefined();
  });

  it('should export openclawAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.openclawAdapter).toBeDefined();
  });

  it('should export opencodeAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.opencodeAdapter).toBeDefined();
  });

  it('should export reasonixAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.reasonixAdapter).toBeDefined();
  });

  it('should export tomlLite', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.tomlLite).toBeDefined();
  });

  it('should export ycodeAdapter', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod.ycodeAdapter).toBeDefined();
  });

  it('should export _shared', () => {
    const mod = require('../../../src/services/externalApps');
    expect(mod._shared).toBeDefined();
  });
});
