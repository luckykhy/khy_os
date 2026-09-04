'use strict';

const extractEndpoint = require('../../src/utils/extractEndpoint');

describe('extractEndpoint', () => {
  test('extracts URL from text', () => {
    expect(extractEndpoint('Visit https://example.com/path for more')).toBe('https://example.com/path');
  });

  test('strips trailing Chinese punctuation', () => {
    expect(extractEndpoint('Link: https://example.com，')).toBe('https://example.com');
  });

  test('strips trailing semicolons', () => {
    expect(extractEndpoint('Link: https://example.com;')).toBe('https://example.com');
  });

  test('returns empty string for no URL', () => {
    expect(extractEndpoint('No URL here')).toBe('');
  });

  test('returns empty string for non-string input', () => {
    expect(extractEndpoint(null)).toBe('');
    expect(extractEndpoint(123)).toBe('');
  });

  test('handles http URLs', () => {
    expect(extractEndpoint('http://example.com')).toBe('http://example.com');
  });
});
