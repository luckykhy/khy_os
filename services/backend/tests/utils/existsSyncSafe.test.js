'use strict';

const existsSyncSafe = require('../../src/utils/existsSyncSafe');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('existsSyncSafe', () => {
  const tmpDir = path.join(os.tmpdir(), `khy-test-${Date.now()}`);
  const testFile = path.join(tmpDir, 'test.txt');

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(testFile, 'hello', 'utf8');
  });

  afterAll(() => {
    try { fs.unlinkSync(testFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  test('returns true for existing file', () => {
    expect(existsSyncSafe(testFile)).toBe(true);
  });

  test('returns false for non-existent file', () => {
    expect(existsSyncSafe('/non/existent/file.txt')).toBe(false);
  });

  test('returns false for invalid input', () => {
    expect(existsSyncSafe(null)).toBe(false);
    expect(existsSyncSafe(undefined)).toBe(false);
  });
});
