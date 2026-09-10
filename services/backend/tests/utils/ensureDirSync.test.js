'use strict';

const fs = require('fs');

jest.mock('fs');

const ensureDirSync = require('../../src/utils/ensureDirSync');

describe('ensureDirSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('creates directory if it does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    ensureDirSync('/tmp/test-dir');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test-dir', { recursive: true });
  });

  test('does not create directory if it exists', () => {
    fs.existsSync.mockReturnValue(true);
    ensureDirSync('/tmp/existing-dir');
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  test('passes recursive: true option', () => {
    fs.existsSync.mockReturnValue(false);
    ensureDirSync('/a/b/c');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/a/b/c', { recursive: true });
  });

  test('handles root-level directory', () => {
    fs.existsSync.mockReturnValue(false);
    ensureDirSync('/single');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/single', { recursive: true });
  });

  test('handles deeply nested path', () => {
    fs.existsSync.mockReturnValue(false);
    ensureDirSync('/a/b/c/d/e/f');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/a/b/c/d/e/f', { recursive: true });
  });
});
