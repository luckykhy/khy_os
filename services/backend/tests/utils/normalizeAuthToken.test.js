'use strict';

const normalizeAuthToken = require('../../src/utils/normalizeAuthToken');

describe('normalizeAuthToken', () => {
  test('normalizes khy- prefix', () => {
    expect(normalizeAuthToken('khy-abc123')).toBe('khy-abc123');
  });

  test('normalizes khy prefix (no dash)', () => {
    expect(normalizeAuthToken('khyabc123')).toBe('khy-abc123');
  });

  test('normalizes khy prefix with underscore', () => {
    expect(normalizeAuthToken('khy_abc123')).toBe('khy-abc123');
  });

  test('adds khy- prefix if missing', () => {
    expect(normalizeAuthToken('abc123')).toBe('khy-abc123');
  });

  test('is case-insensitive for prefix', () => {
    expect(normalizeAuthToken('KHY-abc123')).toBe('khy-abc123');
    expect(normalizeAuthToken('Khy-abc123')).toBe('khy-abc123');
  });

  test('trims whitespace', () => {
    expect(normalizeAuthToken('  khy-abc123  ')).toBe('khy-abc123');
  });

  test('handles empty string with allowEmpty', () => {
    expect(normalizeAuthToken('')).toBe('');
    expect(normalizeAuthToken('', { allowEmpty: true })).toBe('');
  });

  test('returns null for empty string without allowEmpty', () => {
    expect(normalizeAuthToken('', { allowEmpty: false })).toBe(null);
  });

  test('returns null for null/undefined without allowEmpty', () => {
    expect(normalizeAuthToken(null, { allowEmpty: false })).toBe(null);
    expect(normalizeAuthToken(undefined, { allowEmpty: false })).toBe(null);
  });
});
