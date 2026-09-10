'use strict';

const fs = require('fs');

jest.mock('fs');

const existsSyncSafe = require('../../src/utils/existsSyncSafe');

describe('existsSyncSafe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns true when path exists', () => {
    fs.existsSync.mockReturnValue(true);
    expect(existsSyncSafe('/some/path')).toBe(true);
    expect(fs.existsSync).toHaveBeenCalledWith('/some/path');
  });

  test('returns false when path does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    expect(existsSyncSafe('/nonexistent')).toBe(false);
  });

  test('returns false when fs.existsSync throws', () => {
    fs.existsSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(existsSyncSafe('/restricted')).toBe(false);
  });

  test('handles null path', () => {
    fs.existsSync.mockReturnValue(false);
    expect(existsSyncSafe(null)).toBe(false);
  });

  test('handles undefined path', () => {
    fs.existsSync.mockReturnValue(false);
    expect(existsSyncSafe(undefined)).toBe(false);
  });

  test('handles empty string path', () => {
    fs.existsSync.mockReturnValue(false);
    expect(existsSyncSafe('')).toBe(false);
  });
});
