'use strict';

const normalizeCompatibility = require('../../src/utils/normalizeCompatibility');

describe('normalizeCompatibility', () => {
  test('returns openai for empty input', () => {
    expect(normalizeCompatibility('')).toBe('openai');
    expect(normalizeCompatibility(null)).toBe('openai');
    expect(normalizeCompatibility(undefined)).toBe('openai');
  });

  test('normalizes openai variants', () => {
    expect(normalizeCompatibility('openai')).toBe('openai');
    expect(normalizeCompatibility('openai-compatible')).toBe('openai');
    expect(normalizeCompatibility('openai_compatible')).toBe('openai');
  });

  test('normalizes anthropic variants', () => {
    expect(normalizeCompatibility('anthropic')).toBe('anthropic');
    expect(normalizeCompatibility('anthropic-compatible')).toBe('anthropic');
    expect(normalizeCompatibility('anthropic_compatible')).toBe('anthropic');
  });

  test('normalizes unknown/auto/detect', () => {
    expect(normalizeCompatibility('unknown')).toBe('unknown');
    expect(normalizeCompatibility('auto')).toBe('unknown');
    expect(normalizeCompatibility('detect')).toBe('unknown');
  });

  test('returns empty string for unrecognized', () => {
    expect(normalizeCompatibility('gemini')).toBe('');
  });

  test('is case-insensitive', () => {
    expect(normalizeCompatibility('OPENAI')).toBe('openai');
    expect(normalizeCompatibility('Anthropic')).toBe('anthropic');
  });

  test('trims whitespace', () => {
    expect(normalizeCompatibility('  openai  ')).toBe('openai');
  });
});
