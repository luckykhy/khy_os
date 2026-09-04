'use strict';

const readFileSyncSafe = require('../../src/utils/readFileSyncSafe');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('readFileSyncSafe', () => {
  const tmpDir = path.join(os.tmpdir(), `khy-test-${Date.now()}`);
  const testFile = path.join(tmpDir, 'test.txt');

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(testFile, 'hello world', 'utf8');
  });

  afterAll(() => {
    try { fs.unlinkSync(testFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  test('reads existing file', () => {
    expect(readFileSyncSafe(testFile)).toBe('hello world');
  });

  test('returns empty string for non-existent file', () => {
    expect(readFileSyncSafe('/non/existent/file.txt')).toBe('');
  });

  test('returns empty string for invalid path', () => {
    expect(readFileSyncSafe(null)).toBe('');
    expect(readFileSyncSafe(undefined)).toBe('');
  });
});
