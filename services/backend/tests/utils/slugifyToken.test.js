'use strict';

const slugifyToken = require('../../src/utils/slugifyToken');

describe('slugifyToken', () => {
  test('returns default for empty input', () => {
    expect(slugifyToken('')).toBe('default');
    expect(slugifyToken(null)).toBe('default');
    expect(slugifyToken(undefined)).toBe('default');
  });

  test('replaces special characters with underscore', () => {
    expect(slugifyToken('hello/world')).toBe('hello_world');
    expect(slugifyToken('test\\path')).toBe('test_path');
    expect(slugifyToken('a b c')).toBe('a_b_c');
  });

  test('preserves valid characters', () => {
    expect(slugifyToken('abc123')).toBe('abc123');
    expect(slugifyToken('test-file_name.txt')).toBe('test-file_name.txt');
  });

  test('caps at 120 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugifyToken(long)).toHaveLength(120);
  });

  test('handles unicode', () => {
    expect(slugifyToken('héllo')).toBe('h_llo');
  });
});
