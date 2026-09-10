'use strict';

const permissions = require('../../src/permissions/index');

describe('permissions index', () => {
  test('module is defined', () => {
    expect(permissions).toBeDefined();
  });

  test('exports bashSecurity', () => {
    expect(permissions.bashSecurity).toBeDefined();
  });

  test('exports rules', () => {
    expect(permissions.rules).toBeDefined();
  });

  test('bashSecurity is an object (module)', () => {
    expect(typeof permissions.bashSecurity).toBe('object');
  });

  test('rules is an object (module)', () => {
    expect(typeof permissions.rules).toBe('object');
  });

  test('module has exactly 2 exports', () => {
    const keys = Object.keys(permissions);
    expect(keys.length).toBe(2);
  });

  test('module does not export retired mode functions', () => {
    expect(permissions).not.toHaveProperty('getPermissionMode');
    expect(permissions).not.toHaveProperty('setPermissionMode');
    expect(permissions).not.toHaveProperty('cyclePermissionMode');
    expect(permissions).not.toHaveProperty('checkPermission');
    expect(permissions).not.toHaveProperty('getModeDescription');
  });

  test('exports match expected keys', () => {
    expect(Object.keys(permissions).sort().toEqual(['bashSecurity', 'rules'].sort();
  });
});

