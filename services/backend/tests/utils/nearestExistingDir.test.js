'use strict';

const nearestExistingDir = require('../../src/utils/nearestExistingDir');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('nearestExistingDir', () => {
  const tmpDir = path.join(os.tmpdir(), `khy-test-${Date.now()}`);
  const nestedDir = path.join(tmpDir, 'a', 'b', 'c');

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  });

  test('returns the directory itself if it exists', () => {
    expect(nearestExistingDir(path.join(tmpDir, 'file.txt'))).toBe(tmpDir);
  });

  test('returns nearest existing ancestor', () => {
    expect(nearestExistingDir(path.join(nestedDir, 'file.txt'))).toBe(tmpDir);
  });

  test('returns null if no ancestor exists', () => {
    expect(nearestExistingDir('/non/existent/path/file.txt')).toBe(null);
  });
});
