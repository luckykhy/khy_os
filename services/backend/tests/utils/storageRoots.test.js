'use strict';

const {
  getSystemDriveRoot,
  freeBytesFor,
  totalBytesFor,
  isWritable,
  listNonSystemDrives,
  pickBestNonSystemDrive,
  resolveGeneratedFileDir,
} = require('../../src/utils/storageRoots');

describe('storageRoots', () => {
  describe('getSystemDriveRoot', () => {
    test('returns system drive root for platform', () => {
      const root = getSystemDriveRoot({ platform: 'win32', env: { SystemDrive: 'C:' } });
      expect(root).toBe('C:\\');
    });

    test('returns / for posix', () => {
      const root = getSystemDriveRoot({ platform: 'linux', env: {} });
      expect(root).toBe('/');
    });
  });

  describe('freeBytesFor', () => {
    test('returns number for valid path', () => {
      const result = freeBytesFor('/', { fsImpl: require('fs') });
      expect(typeof result).toBe('number');
    });

    test('returns 0 for invalid path', () => {
      const result = freeBytesFor('/non/existent/path', { fsImpl: require('fs') });
      expect(result).toBe(0);
    });
  });

  describe('totalBytesFor', () => {
    test('returns number for valid path', () => {
      const result = totalBytesFor('/', { fsImpl: require('fs') });
      expect(typeof result).toBe('number');
    });
  });

  describe('isWritable', () => {
    test('returns boolean', () => {
      const result = isWritable('/', { fsImpl: require('fs') });
      expect(typeof result).toBe('boolean');
    });
  });

  describe('listNonSystemDrives', () => {
    test('returns array', () => {
      const result = listNonSystemDrives({ fsImpl: require('fs') });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('pickBestNonSystemDrive', () => {
    test('returns object or null', () => {
      const result = pickBestNonSystemDrive({ fsImpl: require('fs') });
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('resolveGeneratedFileDir', () => {
    test('returns dir and source', () => {
      const result = resolveGeneratedFileDir({ subdir: 'test', fsImpl: require('fs') });
      expect(result).toHaveProperty('dir');
      expect(result).toHaveProperty('source');
    });

    test('uses env override when set', () => {
      const result = resolveGeneratedFileDir({
        subdir: 'test',
        env: { KHY_OUTPUT_HOME: '/tmp/test-output' },
        fsImpl: require('fs'),
      });
      expect(result.source).toBe('env');
      expect(result.dir).toContain('/tmp/test-output');
    });
  });
});
