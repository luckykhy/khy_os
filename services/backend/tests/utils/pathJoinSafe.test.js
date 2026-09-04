'use strict';

const pathJoinSafe = require('../../src/utils/pathJoinSafe');

describe('pathJoinSafe', () => {
  test('joins valid paths', () => {
    expect(pathJoinSafe('a', 'b', 'c')).toBe(require('path').join('a', 'b', 'c'));
  });

  test('returns empty string for undefined', () => {
    expect(pathJoinSafe('a', undefined, 'c')).toBe('');
  });

  test('returns empty string for null', () => {
    expect(pathJoinSafe('a', null, 'c')).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(pathJoinSafe('a', '', 'c')).toBe('');
  });

  test('converts non-string to string', () => {
    expect(pathJoinSafe('a', 123)).toBe(require('path').join('a', '123'));
  });

  test('handles single part', () => {
    expect(pathJoinSafe('a')).toBe('a');
  });
});
