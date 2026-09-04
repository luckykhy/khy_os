'use strict';

const collapseWhitespace = require('../../src/utils/collapseWhitespace');

describe('collapseWhitespace', () => {
  test('collapses multiple spaces', () => {
    expect(collapseWhitespace('hello    world')).toBe('hello world');
  });

  test('collapses tabs and newlines', () => {
    expect(collapseWhitespace('hello\t\nworld')).toBe('hello world');
  });

  test('trims leading/trailing whitespace', () => {
    expect(collapseWhitespace('  hello world  ')).toBe('hello world');
  });

  test('handles null', () => {
    expect(collapseWhitespace(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(collapseWhitespace(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(collapseWhitespace('')).toBe('');
  });
});
