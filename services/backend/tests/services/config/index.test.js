'use strict';

describe('services/config/index', () => {
  it('should export langPreference', () => {
    const mod = require('../../../src/services/config');
    expect(mod.langPreference).toBeDefined();
  });

  it('should export nlActionResolver', () => {
    const mod = require('../../../src/services/config');
    expect(mod.nlActionResolver).toBeDefined();
  });

  it('should export nlConfigResolver', () => {
    const mod = require('../../../src/services/config');
    expect(mod.nlConfigResolver).toBeDefined();
  });

  it('should export nlExternalAppImportResolver', () => {
    const mod = require('../../../src/services/config');
    expect(mod.nlExternalAppImportResolver).toBeDefined();
  });

  it('should export nlExternalAppResolver', () => {
    const mod = require('../../../src/services/config');
    expect(mod.nlExternalAppResolver).toBeDefined();
  });

  it('should export nlInstallVsConfigGuard', () => {
    const mod = require('../../../src/services/config');
    expect(mod.nlInstallVsConfigGuard).toBeDefined();
  });

  it('should export nlProviderResolver', () => {
    const mod = require('../../../src/services/config');
    expect(mod.nlProviderResolver).toBeDefined();
  });

  it('should export philosophyDesignResolver', () => {
    const mod = require('../../../src/services/config');
    expect(mod.philosophyDesignResolver).toBeDefined();
  });

  it('should export sandboxToggleState', () => {
    const mod = require('../../../src/services/config');
    expect(mod.sandboxToggleState).toBeDefined();
  });
});
