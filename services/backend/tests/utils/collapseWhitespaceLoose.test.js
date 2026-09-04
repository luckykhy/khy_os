'use strict';

const collapseWhitespaceLoose = require('../../src/utils/collapseWhitespaceLoose');

describe('collapseWhitespaceLoose', () => {
  test('collapses multiple spaces', () => {
    expect(collapseWhitespaceLoose('hello    world')).toBe('hello world');
  });

  test('collapses tabs and newlines', () => {
    expect(collapseWhitespaceLoose('hello\t\nworld')).toBe('hello world');
  });

  test('trims leading/trailing whitespace', () => {
    expect(collapseWhitespaceLoose('  hello world  ')).toBe('hello world');
  });

  test('handles null', () => {
    expect(collapseWhitespaceLoose(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(collapseWhitespaceLoose(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(collapseWhitespaceLoose('')).toBe('');
  });

  test('handles falsy values (0, false)', () => {
    expect(collapseWhitespaceLoose(0)).toBe('');
    expect(collapseWhitespaceLoose(false)).toBe('');
  });
});
