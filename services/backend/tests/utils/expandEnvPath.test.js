'use strict';

const expandEnvPath = require('../../src/utils/expandEnvPath');

describe('expandEnvPath', () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('expands environment variables on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.MY_DIR = 'C:\\Users\\test';
    expect(expandEnvPath('%MY_DIR%\\file.txt')).toBe('C:\\Users\\test\\file.txt');
  });

  test('expands environment variables on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.MY_DIR = '/home/test';
    expect(expandEnvPath('$MY_DIR/file.txt')).toBe('/home/test/file.txt');
  });

  test('expands ${VAR} syntax on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.MY_DIR = '/home/test';
    expect(expandEnvPath('${MY_DIR}/file.txt')).toBe('/home/test/file.txt');
  });

  test('keeps missing env var on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.MISSING;
    expect(expandEnvPath('%MISSING%\\file.txt')).toBe('%MISSING%\\file.txt');
  });

  test('replaces ~ with home directory', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const os = require('os');
    expect(expandEnvPath('~/file.txt')).toBe(require('path').join(os.homedir(), 'file.txt'));
  });

  test('handles empty string', () => {
    expect(expandEnvPath('')).toBe('');
  });

  test('handles null/undefined', () => {
    expect(expandEnvPath(null)).toBe('');
    expect(expandEnvPath(undefined)).toBe('');
  });
});
