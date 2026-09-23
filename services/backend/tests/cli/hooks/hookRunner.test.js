'use strict';

const hookRunner = require('../../../src/cli/hooks/hookRunner.js');

describe('hookRunner', () => {
  test('module is defined', () => {
    expect(hookRunner).toBeDefined();
  });

  test('exports a module (object)', () => {
    expect(typeof hookRunner).toBe('object');
  });

  test('re-exports from hookRunner.js', () => {
    expect(hookRunner).not.toBeNull();
  });
});

