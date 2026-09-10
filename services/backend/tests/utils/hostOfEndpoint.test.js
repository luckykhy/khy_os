'use strict';

const _hostOf = require('../../src/utils/hostOfEndpoint');

describe('hostOfEndpoint', () => {
  test('extracts hostname from https URL', () => {
    expect(_hostOf('https://api.example.com/v1')).toBe('api.example.com');
  });

  test('extracts hostname from http URL', () => {
    expect(_hostOf('http://localhost:3000/path')).toBe('localhost');
  });

  test('handles bare host', () => {
    expect(_hostOf('example.com')).toBe('example.com');
  });

  test('handles bare host with port', () => {
    expect(_hostOf('localhost:3000')).toBe('localhost');
  });

  test('returns empty string for empty input', () => {
    expect(_hostOf('')).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(_hostOf(null)).toBe('');
    expect(_hostOf(undefined)).toBe('');
  });

  test('lowercases hostname', () => {
    expect(_hostOf('https://API.Example.COM')).toBe('api.example.com');
  });

  test('handles URL with auth', () => {
    expect(_hostOf('https://user:pass@api.example.com')).toBe('api.example.com');
  });
});
