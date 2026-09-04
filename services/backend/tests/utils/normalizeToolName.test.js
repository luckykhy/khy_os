'use strict';

const normalizeToolName = require('../../src/utils/normalizeToolName');

describe('normalizeToolName', () => {
  test('converts to lowercase', () => {
    expect(normalizeToolName('ReadFile')).toBe('readfile');
  });

  test('removes underscores', () => {
    expect(normalizeToolName('read_file')).toBe('readfile');
  });

  test('removes hyphens', () => {
    expect(normalizeToolName('read-file')).toBe('readfile');
  });

  test('removes spaces', () => {
    expect(normalizeToolName('read file')).toBe('readfile');
  });

  test('handles mixed separators', () => {
    expect(normalizeToolName('Read_File-Name')).toBe('readfilename');
  });

  test('handles empty string', () => {
    expect(normalizeToolName('')).toBe('');
  });

  test('handles null/undefined', () => {
    expect(normalizeToolName(null)).toBe('');
    expect(normalizeToolName(undefined)).toBe('');
  });
});
