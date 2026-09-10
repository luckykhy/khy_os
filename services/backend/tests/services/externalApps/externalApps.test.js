'use strict';

const externalApps = require('../../src/services/externalApps/index');

describe('externalApps index', () => {
  test('module is defined', () => {
    expect(externalApps).toBeDefined();
  });

  test('exports appModelImporter', () => {
    expect(externalApps.appModelImporter).toBeDefined();
  });

  test('exports claudeCodeAdapter', () => {
    expect(externalApps.claudeCodeAdapter).toBeDefined();
  });

  test('exports commandCodeAdapter', () => {
    expect(externalApps.commandCodeAdapter).toBeDefined();
  });

  test('exports cozeAdapter', () => {
    expect(externalApps.cozeAdapter).toBeDefined();
  });

  test('exports deepseekTuiAdapter', () => {
    expect(externalApps.deepseekTuiAdapter).toBeDefined();
  });

  test('exports geminiCliAdapter', () => {
    expect(externalApps.geminiCliAdapter).toBeDefined();
  });

  test('exports openclawAdapter', () => {
    expect(externalApps.openclawAdapter).toBeDefined();
  });

  test('exports opencodeAdapter', () => {
    expect(externalApps.opencodeAdapter).toBeDefined();
  });

  test('exports reasonixAdapter', () => {
    expect(externalApps.reasonixAdapter).toBeDefined();
  });

  test('exports tomlLite', () => {
    expect(externalApps.tomlLite).toBeDefined();
  });

  test('exports ycodeAdapter', () => {
    expect(externalApps.ycodeAdapter).toBeDefined();
  });

  test('exports _shared', () => {
    expect(externalApps._shared).toBeDefined();
  });

  test('all exports are objects (modules)', () => {
    expect(typeof externalApps.appModelImporter).toBe('object');
    expect(typeof externalApps.claudeCodeAdapter).toBe('object');
    expect(typeof externalApps.commandCodeAdapter).toBe('object');
    expect(typeof externalApps.cozeAdapter).toBe('object');
    expect(typeof externalApps.deepseekTuiAdapter).toBe('object');
    expect(typeof externalApps.geminiCliAdapter).toBe('object');
    expect(typeof externalApps.openclawAdapter).toBe('object');
    expect(typeof externalApps.opencodeAdapter).toBe('object');
    expect(typeof externalApps.reasonixAdapter).toBe('object');
    expect(typeof externalApps.tomlLite).toBe('object');
    expect(typeof externalApps.ycodeAdapter).toBe('object');
    expect(typeof externalApps._shared).toBe('object');
  });
});

