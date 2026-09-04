'use strict';

const stripCodeSpans = require('../../src/utils/stripCodeSpans');

describe('stripCodeSpans', () => {
  test('removes fenced code blocks', () => {
    expect(stripCodeSpans('text ```code``` more')).toBe('text   more');
  });

  test('removes inline code spans', () => {
    expect(stripCodeSpans('text `code` more')).toBe('text   more');
  });

  test('handles multiple code spans', () => {
    expect(stripCodeSpans('`a` text `b`')).toBe('  text  ');
  });

  test('handles null', () => {
    expect(stripCodeSpans(null)).toBe('');
  });

  test('handles undefined', () => {
    expect(stripCodeSpans(undefined)).toBe('');
  });

  test('handles empty string', () => {
    expect(stripCodeSpans('')).toBe('');
  });

  test('handles non-string', () => {
    expect(stripCodeSpans(123)).toBe('123');
  });
});
