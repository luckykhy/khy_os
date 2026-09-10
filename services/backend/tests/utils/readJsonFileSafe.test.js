'use strict';

const fs = require('fs');

jest.mock('fs');

const readJsonFileSafe = require('../../src/utils/readJsonFileSafe');

describe('readJsonFileSafe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns parsed JSON on success', () => {
    fs.readFileSync.mockReturnValue('{"key":"value"}');
    const result = readJsonFileSafe('/path/to/file.json');
    expect(result).toEqual({ key: 'value' });
    expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/file.json', 'utf-8');
  });

  test('returns null for non-existent file', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(readJsonFileSafe('/nonexistent.json')).toBeNull();
  });

  test('returns null for malformed JSON', () => {
    fs.readFileSync.mockReturnValue('{ invalid json }');
    expect(readJsonFileSafe('/bad.json')).toBeNull();
  });

  test('returns null for permission error', () => {
    fs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(readJsonFileSafe('/restricted.json')).toBeNull();
  });

  test('handles array JSON', () => {
    fs.readFileSync.mockReturnValue('[1,2,3]');
    expect(readJsonFileSafe('/array.json')).toEqual([1, 2, 3]);
  });

  test('handles empty object', () => {
    fs.readFileSync.mockReturnValue('{}');
    expect(readJsonFileSafe('/empty.json')).toEqual({});
  });

  test('handles null JSON value', () => {
    fs.readFileSync.mockReturnValue('null');
    expect(readJsonFileSafe('/null.json')).toBeNull();
  });
});
