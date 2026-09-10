'use strict';

const collapseWhitespaceLoose = require('../../src/utils/collapseWhitespaceLoose');

describe('collapseWhitespaceLoose', () => {
  test('collapses multiple spaces', () => {
    expect(collapseWhitespaceLoose('hello    world')).toBe('hello world');
  });

  test('collapses tabs', () => {
    expect(collapseWhitespaceLoose('hello\t\tworld')).toBe('hello world');
  });

  test('collapses newlines', () => {
    expect(collapseWhitespaceLoose('hello\n\nworld')).toBe('hello world');
  });

  test('collapses mixed whitespace', () => {
    expect(collapseWhitespaceLoose('hello \t\n world')).toBe('hello world');
  });

  test('trims leading/trailing whitespace', () => {
    expect(collapseWhitespaceLoose('  hello world  ')).toBe('hello world');
  });

  test('handles empty string', () => {
    expect(collapseWhitespaceLoose('')).toBe('');
  });

  test('handles null', () => {
    expect(collapseWhitespaceLoose(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(collapseWhitespaceLoose(undefined)).toBe('');
  });

  test('handles number 0', () => {
    expect(collapseWhitespaceLoose(0)).toBe('');
  });

  test('handles boolean false', () => {
    expect(collapseWhitespaceLoose(false)).toBe('');
  });

  test('preserves single spaces', () => {
    expect(collapseWhitespaceLoose('hello world')).toBe('hello world');
  });

  test('handles only whitespace', () => {
    expect(collapseWhitespaceLoose('   ')).toBe('');
    expect(collapseWhitespaceLoose('\t\n')).toBe('');
  });

  test('handles number input', () => {
    expect(collapseWhitespaceLoose(123)).toBe('123');
  });

  test('handles mixed content', () => {
    expect(collapseWhitespaceLoose('  hello   world  foo  bar  ')).toBe('hello world foo bar');
  });
});
