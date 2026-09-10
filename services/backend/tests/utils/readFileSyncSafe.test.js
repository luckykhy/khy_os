'use strict';

const fs = require('fs');

jest.mock('fs');

const readFileSyncSafe = require('../../src/utils/readFileSyncSafe');

describe('readFileSyncSafe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns file content as string', () => {
    fs.readFileSync.mockReturnValue('hello world');
    const result = readFileSyncSafe('/path/to/file.txt');
    expect(result).toBe('hello world');
    expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/file.txt', 'utf8');
  });

  test('returns empty string for non-existent file', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readFileSyncSafe('/nonexistent.txt')).toBe('');
  });

  test('returns empty string for permission error', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(readFileSyncSafe('/restricted.txt')).toBe('');
  });

  test('returns empty string for any error', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('Unknown error');
    });
    expect(readFileSyncSafe('/some/file.txt')).toBe('');
  });

  test('handles Buffer input - returns Buffer as-is (no conversion)', () => {
    const buf = Buffer.from('buffer content');
    fs.readFileSync.mockReturnValue(buf);
    const result = readFileSyncSafe('/buffer.txt');
    expect(result).toBe(buf);
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  test('handles empty file', () => {
    fs.readFileSync.mockReturnValue('');
    expect(readFileSyncSafe('/empty.txt')).toBe('');
  });
});

