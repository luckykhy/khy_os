'use strict';

/**
 * storageRoots — cross-platform storage placement policy.
 *
 * Verifies, with fully injected fs/platform (no real disks touched):
 *   - getSystemDriveRoot per platform,
 *   - listNonSystemDrives excludes the system drive, filters free<min and
 *     non-writable, and sorts by free space descending (win + linux layouts),
 *   - resolveGeneratedFileDir policy: env > cwd(when room) > non-system > system,
 *     and preferCwd:false skips the cwd.
 *
 * Runnable under both jest and `node --test` via the shim (no jest binary here).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const sr = require('../../src/utils/storageRoots');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
let _afterEach = global.afterEach;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _afterEach = nt.afterEach;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toBeTruthy: () => assert.ok(actual, 'expected truthy'),
    toBeFalsy: () => assert.ok(!actual, 'expected falsy'),
    toBeGreaterThan: (e) => assert.ok(actual > e, `expected ${actual} > ${e}`),
  });
}

const GB = 1024 * 1024 * 1024;

_describe('storageRoots.getSystemDriveRoot', () => {
  _test('win32 uses %SystemDrive%', () => {
    _expect(sr.getSystemDriveRoot({ platform: 'win32', env: { SystemDrive: 'D:' } })).toBe('D:\\');
  });
  _test('win32 defaults to C: when unset', () => {
    _expect(sr.getSystemDriveRoot({ platform: 'win32', env: {} })).toBe('C:\\');
  });
  _test('posix is /', () => {
    _expect(sr.getSystemDriveRoot({ platform: 'linux', env: {} })).toBe('/');
  });
});

_describe('storageRoots.listNonSystemDrives', () => {
  _test('win32: excludes system letter, sorts by free desc, filters small/non-writable', () => {
    const fakeWin = {
      existsSync: (p) => ['C:\\', 'D:\\', 'E:\\', 'F:\\'].includes(p),
      statSync: () => ({ dev: 0, isDirectory: () => true }),
      statfsSync: (p) => ({
        bsize: 1,
        bavail: p === 'D:\\' ? 5 * GB : p === 'E:\\' ? 2 * GB : p === 'F:\\' ? 0.5 * GB : 9 * GB,
        blocks: 10 * GB,
      }),
      accessSync: (p) => { if (p === 'E:\\') { /* writable */ } }, // all writable
      readdirSync: () => [],
    };
    const list = sr.listNonSystemDrives({ platform: 'win32', fsImpl: fakeWin, env: { SystemDrive: 'C:' } });
    _expect(list.length).toBe(2); // D and E pass; F too small (<1GB); C excluded
    _expect(list[0].root).toBe('D:\\');
    _expect(list[1].root).toBe('E:\\');
  });

  _test('win32: drops a non-writable drive', () => {
    const fakeWin = {
      existsSync: (p) => ['C:\\', 'D:\\'].includes(p),
      statSync: () => ({ dev: 0, isDirectory: () => true }),
      statfsSync: () => ({ bsize: 1, bavail: 5 * GB, blocks: 10 * GB }),
      accessSync: (p) => { if (p === 'D:\\') throw new Error('EACCES'); },
      readdirSync: () => [],
    };
    const list = sr.listNonSystemDrives({ platform: 'win32', fsImpl: fakeWin, env: { SystemDrive: 'C:' } });
    _expect(list.length).toBe(0);
  });

  _test('linux: keeps /mnt mounts with a different device, excludes same-device', () => {
    const fakeLinux = {
      existsSync: () => true,
      statSync: (p) => {
        const dev = p === '/' ? 1 : p === '/mnt/d' ? 2 : 1; // /mnt/e shares root dev → excluded
        return { dev, isDirectory: () => true };
      },
      statfsSync: () => ({ bsize: 1, bavail: 5 * GB, blocks: 10 * GB }),
      accessSync: () => {},
      readdirSync: (p) => (p === '/mnt' ? ['d', 'e'] : []),
    };
    const list = sr.listNonSystemDrives({ platform: 'linux', fsImpl: fakeLinux });
    _expect(list.length).toBe(1);
    _expect(list[0].root).toBe('/mnt/d');
  });
});

_describe('storageRoots.resolveGeneratedFileDir', () => {
  _afterEach(() => { try { sr._resetNoteFlag(); } catch { /* ignore */ } });

  _test('env override wins (source=env)', () => {
    const fake = { mkdirSync: () => {} };
    const r = sr.resolveGeneratedFileDir({
      subdir: 'models',
      deps: { env: { KHY_OUTPUT_HOME: '/out' }, fsImpl: fake, platform: 'linux' },
    });
    _expect(r.source).toBe('env');
    _expect(r.dir).toBe(path.join('/out', 'models'));
  });

  _test('cwd chosen when it has room (source=cwd)', () => {
    const fake = {
      mkdirSync: () => {},
      accessSync: () => {},
      statfsSync: () => ({ bsize: 1, bavail: 5 * GB, blocks: 10 * GB }),
    };
    const r = sr.resolveGeneratedFileDir({
      subdir: 'out',
      deps: { env: {}, fsImpl: fake, platform: 'linux', cwd: '/work' },
    });
    _expect(r.source).toBe('cwd');
    _expect(r.dir).toBe(path.join('/work', 'out'));
  });

  _test('cwd full falls through to the largest non-system drive', () => {
    const fake = {
      mkdirSync: () => {},
      accessSync: () => {},
      existsSync: () => true,
      statSync: (p) => ({ dev: p === '/' ? 1 : 2, isDirectory: () => true }),
      statfsSync: (p) => ({ bsize: 1, bavail: p === '/work' ? 1 : 5 * GB, blocks: 10 * GB }),
      readdirSync: (p) => (p === '/mnt' ? ['d'] : []),
    };
    const r = sr.resolveGeneratedFileDir({
      subdir: 'out',
      deps: { env: {}, fsImpl: fake, platform: 'linux', cwd: '/work', homedir: '/home/u' },
    });
    _expect(r.source).toBe('non-system-drive');
    _expect(r.dir).toBe(path.join('/mnt/d', '.khy', 'out'));
  });

  _test('preferCwd:false skips the cwd even with room', () => {
    const fake = {
      mkdirSync: () => {},
      accessSync: () => {},
      existsSync: () => true,
      statSync: (p) => ({ dev: p === '/' ? 1 : 2, isDirectory: () => true }),
      statfsSync: () => ({ bsize: 1, bavail: 5 * GB, blocks: 10 * GB }),
      readdirSync: (p) => (p === '/mnt' ? ['d'] : []),
    };
    const r = sr.resolveGeneratedFileDir({
      subdir: 'models',
      preferCwd: false,
      deps: { env: {}, fsImpl: fake, platform: 'linux', cwd: '/work', homedir: '/home/u' },
    });
    _expect(r.source).toBe('non-system-drive');
  });

  _test('no drives → system default (never crashes)', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-sr-sys-'));
    const OLD = process.env.KHY_DATA_HOME;
    process.env.KHY_DATA_HOME = tmpHome;
    try {
      const dh = require('../../src/utils/dataHome');
      dh._resetStorageCaches();
      const fake = {
        mkdirSync: () => {},
        accessSync: () => {},
        existsSync: () => false,
        statSync: () => ({ dev: 1, isDirectory: () => true }),
        statfsSync: () => ({ bsize: 1, bavail: 0, blocks: 10 * GB }),
        readdirSync: () => [],
      };
      const r = sr.resolveGeneratedFileDir({
        subdir: 'tmp/tasks',
        preferCwd: false,
        deps: { env: {}, fsImpl: fake, platform: 'linux', cwd: '/work', homedir: '/home/u' },
      });
      _expect(r.source).toBe('system');
      _expect(r.dir).toContain(tmpHome);
    } finally {
      if (OLD === undefined) delete process.env.KHY_DATA_HOME; else process.env.KHY_DATA_HOME = OLD;
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
