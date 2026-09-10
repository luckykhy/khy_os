'use strict';

const config = require('../../src/services/config/index');

describe('config index', () => {
  test('module is defined', () => {
    expect(config).toBeDefined();
  });

  test('exports langPreference', () => {
    expect(config.langPreference).toBeDefined();
  });

  test('exports nlActionResolver', () => {
    expect(config.nlActionResolver).toBeDefined();
  });

  test('exports nlConfigResolver', () => {
    expect(config.nlConfigResolver).toBeDefined();
  });

  test('exports nlExternalAppImportResolver', () => {
    expect(config.nlExternalAppImportResolver).toBeDefined();
  });

  test('exports nlExternalAppResolver', () => {
    expect(config.nlExternalAppResolver).toBeDefined();
  });

  test('exports nlInstallVsConfigGuard', () => {
    expect(config.nlInstallVsConfigGuard).toBeDefined();
  });

  test('exports nlProviderResolver', () => {
    expect(config.nlProviderResolver).toBeDefined();
  });

  test('exports philosophyDesignResolver', () => {
    expect(config.philosophyDesignResolver).toBeDefined();
  });

  test('exports sandboxToggleState', () => {
    expect(config.sandboxToggleState).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof config.langPreference).toBe('object');
    expect(typeof config.nlActionResolver).toBe('object');
    expect(typeof config.nlConfigResolver).toBe('object');
    expect(typeof config.nlExternalAppImportResolver).toBe('object');
    expect(typeof config.nlExternalAppResolver).toBe('object');
    expect(typeof config.nlInstallVsConfigGuard).toBe('object');
    expect(typeof config.nlProviderResolver).toBe('object');
    expect(typeof config.philosophyDesignResolver).toBe('object');
    expect(typeof config.sandboxToggleState).toBe('object');
  });
});

