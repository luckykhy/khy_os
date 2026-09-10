'use strict';

const _platformCtx = require('../../src/utils/platformCtx');

describe('_platformCtx', () => {
  test('returns object with id and appliesTo', () => {
    const result = _platformCtx();
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('appliesTo');
  });

  test('id is a string', () => {
    const result = _platformCtx();
    expect(typeof result.id).toBe('string');
  });

  test('appliesTo is a function', () => {
    const result = _platformCtx();
    expect(typeof result.appliesTo).toBe('function');
  });

  test('appliesTo returns boolean', () => {
    const result = _platformCtx();
    expect(typeof result.appliesTo('linux')).toBe('boolean');
  });

  test('never throws', () => {
    expect(() => _platformCtx()).not.toThrow();
  });

  test('returns valid platform id', () => {
    const result = _platformCtx();
    const validIds = ['linux', 'windows', 'macos', 'android', 'harmonyos', 'ios'];
    expect(validIds).toContain(result.id);
  });
});

