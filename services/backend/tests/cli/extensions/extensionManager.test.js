'use strict';

const extensionManager = require('../../src/cli/extensions/extensionManager');

describe('extensionManager', () => {
  test('module is defined', () => {
    expect(extensionManager).toBeDefined();
  });

  test('exports a module (object)', () => {
    expect(typeof extensionManager).toBe('object');
  });

  test('re-exports from extensionManager.js', () => {
    expect(extensionManager).not.toBeNull();
  });
});

