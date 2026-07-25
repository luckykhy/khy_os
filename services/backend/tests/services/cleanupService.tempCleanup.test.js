'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const cleanupService = require('../../src/services/cleanupService');

function touchOld(target, hoursAgo) {
  const ts = Date.now() - (hoursAgo * 60 * 60 * 1000);
  const sec = ts / 1000;
  fs.utimesSync(target, sec, sec);
}

describe('cleanupService.cleanOsTempFiles', () => {
  test('removes old managed temp files and directories, keeps fresh/unmanaged entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cleanup-os-temp-'));
    const oldManagedFile = path.join(root, 'khyquant_old_file.tmp');
    const oldManagedDir = path.join(root, 'khy-old-dir');
    const freshManagedFile = path.join(root, 'khy_recent.tmp');
    const oldUnmanagedFile = path.join(root, 'other_old_file.tmp');

    fs.writeFileSync(oldManagedFile, 'old-managed-file');
    fs.mkdirSync(oldManagedDir, { recursive: true });
    fs.writeFileSync(path.join(oldManagedDir, 'payload.txt'), 'old-managed-dir');
    fs.writeFileSync(freshManagedFile, 'fresh-managed-file');
    fs.writeFileSync(oldUnmanagedFile, 'old-unmanaged-file');

    touchOld(oldManagedFile, 2);
    touchOld(oldManagedDir, 2);
    touchOld(path.join(oldManagedDir, 'payload.txt'), 2);
    touchOld(oldUnmanagedFile, 2);

    const previous = process.env.KHY_OS_TEMP_DIR;
    process.env.KHY_OS_TEMP_DIR = root;
    try {
      const result = cleanupService.cleanOsTempFiles();
      expect(result.removed).toBeGreaterThanOrEqual(2);
      expect(result.bytes).toBeGreaterThan(0);

      expect(fs.existsSync(oldManagedFile)).toBe(false);
      expect(fs.existsSync(oldManagedDir)).toBe(false);
      expect(fs.existsSync(freshManagedFile)).toBe(true);
      expect(fs.existsSync(oldUnmanagedFile)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KHY_OS_TEMP_DIR;
      else process.env.KHY_OS_TEMP_DIR = previous;
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

