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

  test('falls back to the filesystem root when no ancestor matches', () => {
    // The fs root always exists (POSIX '/' / Windows current-drive root), so
    // the walk terminates at it; null is reserved for fs errors / 10-level cap.
    expect(nearestExistingDir('/non/existent/path/file.txt')).toBe('/');
  });
});
