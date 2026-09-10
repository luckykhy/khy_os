'use strict';

const _extractEndpoint = require('../../src/utils/extractEndpoint');

describe('_extractEndpoint', () => {
  test('extracts https URL', () => {
    expect(_extractEndpoint('Visit https://example.com/path')).toBe('https://example.com/path');
  });

  test('extracts http URL', () => {
    expect(_extractEndpoint('Visit http://example.com')).toBe('http://example.com');
  });

  test('returns empty string when no URL', () => {
    expect(_extractEndpoint('no url here')).toBe('');
  });

  test('returns empty string for empty input', () => {
    expect(_extractEndpoint('')).toBe('');
  });

  test('returns empty string for null', () => {
    expect(_extractEndpoint(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(_extractEndpoint(undefined)).toBe('');
  });

  test('strips trailing Chinese punctuation', () => {
    expect(_extractEndpoint('URL: https://example.com，')).toBe('https://example.com');
  });

  test('strips trailing semicolons', () => {
    expect(_extractEndpoint('URL: https://example.com;')).toBe('https://example.com');
  });

  test('strips trailing Chinese period', () => {
    expect(_extractEndpoint('URL: https://example.com。')).toBe('https://example.com');
  });

  test('does not strip trailing period (not in regex)', () => {
    expect(_extractEndpoint('URL: https://example.com.')).toBe('https://example.com.');
  });

  test('extracts first URL when multiple present', () => {
    expect(_extractEndpoint('First https://a.com then https://b.com')).toBe('https://a.com');
  });

  test('handles URL with port', () => {
    expect(_extractEndpoint('http://localhost:3000/api')).toBe('http://localhost:3000/api');
  });

  test('handles URL with query params', () => {
    expect(_extractEndpoint('https://api.com/v1?key=value')).toBe('https://api.com/v1?key=value');
  });

  test('handles numeric input', () => {
    expect(_extractEndpoint(12345)).toBe('');
  });

  test('handles object input', () => {
    expect(_extractEndpoint({ url: 'test' })).toBe('');
  });
});
