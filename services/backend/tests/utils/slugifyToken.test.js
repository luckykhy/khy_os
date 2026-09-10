'use strict';

const slugifyToken = require('../../src/utils/slugifyToken');

describe('slugifyToken', () => {
  test('returns safe string for normal input', () => {
    expect(slugifyToken('my-branch')).toBe('my-branch');
  });

  test('replaces spaces with underscore', () => {
    expect(slugifyToken('my branch')).toBe('my_branch');
  });

  test('replaces path separators with underscore', () => {
    expect(slugifyToken('path/to/file')).toBe('path_to_file');
  });

  test('replaces backslashes with underscore', () => {
    expect(slugifyToken('path\\to\\file')).toBe('path_to_file');
  });

  test('returns "default" for null', () => {
    expect(slugifyToken(null)).toBe('default');
  });

  test('returns "default" for undefined', () => {
    expect(slugifyToken(undefined)).toBe('default');
  });

  test('returns "default" for empty string', () => {
    expect(slugifyToken('')).toBe('default');
  });

  test('preserves alphanumeric characters', () => {
    expect(slugifyToken('abc123')).toBe('abc123');
  });

  test('preserves dots', () => {
    expect(slugifyToken('file.json')).toBe('file.json');
  });

  test('preserves underscores', () => {
    expect(slugifyToken('my_token')).toBe('my_token');
  });

  test('preserves hyphens', () => {
    expect(slugifyToken('my-token')).toBe('my-token');
  });

  test('replaces unicode characters', () => {
    expect(slugifyToken('日本語')).toBe('___');
  });

  test('caps at 120 characters', () => {
    const long = 'a'.repeat(200);
    expect(slugifyToken(long).length).toBe(120);
  });

  test('handles exactly 120 characters', () => {
    const exact = 'a'.repeat(120);
    expect(slugifyToken(exact).length).toBe(120);
  });

  test('handles numeric input', () => {
    expect(slugifyToken(123)).toBe('123');
  });

  test('handles object input - stringifies and replaces special chars', () => {
    expect(slugifyToken({})).toBe('_object_Object_');
  });

  test('prevents path traversal', () => {
    expect(slugifyToken('../../../etc/passwd')).toBe('.._.._.._etc_passwd');
  });
});
