'use strict';

const isPathWithin = require('../../src/utils/isPathWithin');

describe('isPathWithin', () => {
  test('returns true for path within parent', () => {
    expect(isPathWithin('/home/user', '/home/user/docs')).toBe(true);
  });

  test('returns true for equal paths', () => {
    expect(isPathWithin('/home/user', '/home/user')).toBe(true);
  });

  test('returns false for path outside parent', () => {
    expect(isPathWithin('/home/user', '/home/other')).toBe(false);
  });

  test('returns false for parent outside target', () => {
    expect(isPathWithin('/home/user/docs', '/home/user')).toBe(false);
  });

  test('returns false for empty input', () => {
    expect(isPathWithin('', '/home/user')).toBe(false);
    expect(isPathWithin('/home/user', '')).toBe(false);
  });

  test('handles relative paths', () => {
    expect(isPathWithin('/home/user', '/home/user/../other')).toBe(false);
  });
});
