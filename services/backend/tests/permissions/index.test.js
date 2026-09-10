'use strict';

const permissions = require('../../src/permissions/index');

describe('permissions/index', () => {
  test('exports bashSecurity', () => {
    expect(permissions).toHaveProperty('bashSecurity');
  });

  test('exports rules', () => {
    expect(permissions).toHaveProperty('rules');
  });

  test('has exactly 2 exports', () => {
    expect(Object.keys(permissions).length).toBe(2);
  });

  test('bashSecurity is a module', () => {
    expect(typeof permissions.bashSecurity).toBe('object');
  });

  test('rules is a module', () => {
    expect(typeof permissions.rules).toBe('object');
  });
});

