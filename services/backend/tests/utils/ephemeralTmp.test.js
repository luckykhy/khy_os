'use strict';

const { withTempDir, createEphemeralDir } = require('../../src/utils/ephemeralTmp');
const fs = require('fs');
const path = require('path');

describe('ephemeralTmp', () => {
  test('withTempDir creates and removes dir', async () => {
    let dirPath;
    const result = await withTempDir((dir) => {
      dirPath = dir;
      expect(fs.existsSync(dir)).toBe(true);
      return 'success';
    });
    expect(result).toBe('success');
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  test('withTempDir removes dir on error', async () => {
    let dirPath;
    try {
      await withTempDir((dir) => {
        dirPath = dir;
        throw new Error('fail');
      });
    } catch {}
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  test('createEphemeralDir returns handle with path and dispose', () => {
    const handle = createEphemeralDir({ prefix: 'test' });
    expect(fs.existsSync(handle.path)).toBe(true);
    expect(fs.existsSync(handle.path)).toBe(true);
    handle.dispose();
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  test('dispose is idempotent', () => {
    const handle = createEphemeralDir();
    handle.dispose();
    handle.dispose(); // should not throw
  });
});
