'use strict';

/**
 * `khy storage migrate` — explicit, verified, reversible live-data relocation.
 *
 * buildMigrationPlan is a PURE planner: with an injected fsImpl it must produce a
 * plan and perform ZERO writes (this is what makes --dry-run safe). We assert the
 * plan shape and every rejection (SAME_DRIVE / INSUFFICIENT_SPACE /
 * TARGET_NOT_WRITABLE / TARGET_EXISTS / NO_TARGET), then exercise executeMigration
 * end-to-end on real temp dirs (copy → verify → atomic pointer flip → rollback),
 * proving the source is preserved as a backup and the pointer round-trips.
 *
 * Runs under jest or `node --test` via the shim (no jest binary in this checkout).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const storage = require('../../src/cli/handlers/storage');
const dh = require('../../src/utils/dataHome');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
let _afterEach = global.afterEach;
let _beforeEach = global.beforeEach;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _afterEach = nt.afterEach;
  _beforeEach = nt.beforeEach;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toBeTruthy: () => assert.ok(actual, 'expected truthy'),
    toBeFalsy: () => assert.ok(!actual, 'expected falsy'),
    toBeGreaterThanOrEqual: (e) => assert.ok(actual >= e, `expected ${actual} >= ${e}`),
  });
}

const GB = 1024 * 1024 * 1024;

/* A configurable in-memory fs for the PURE planner. `mutated` records any write
 * so we can prove buildMigrationPlan touches nothing. */
function makeFake({ devOf, free, writable = true, targetHasContent = false, drives = [], fileSize = 10 } = {}) {
  const mutated = [];
  const trap = (op) => (...a) => { mutated.push([op, ...a]); };
  return {
    mutated,
    fsImpl: {
      existsSync: (p) => {
        if (p.endsWith(`${path.sep}.khy`) || p.endsWith(`${path.sep}.khy-project`)) return targetHasContent;
        return true;
      },
      accessSync: () => { if (!writable) throw new Error('EACCES'); },
      statfsSync: () => ({ bsize: 1, bavail: free, blocks: 100 * GB }),
      statSync: (p) => ({ dev: devOf(p), size: fileSize, isDirectory: () => false, isSymbolicLink: () => false }),
      readdirSync: (p, opts) => {
        if (opts && opts.withFileTypes) {
          return [
            { name: 'a.txt', isSymbolicLink: () => false, isDirectory: () => false },
            { name: 'b.txt', isSymbolicLink: () => false, isDirectory: () => false },
          ];
        }
        // non-empty target probe
        if (p.endsWith(`${path.sep}.khy`) || p.endsWith(`${path.sep}.khy-project`)) {
          return targetHasContent ? ['old.db'] : [];
        }
        // drive enumeration for pickBestNonSystemDrive (NO_TARGET case)
        if (p === '/mnt') return drives;
        return [];
      },
      mkdirSync: trap('mkdir'),
      writeFileSync: trap('write'),
      cpSync: trap('cp'),
      renameSync: trap('rename'),
    },
  };
}

_describe('storage.buildMigrationPlan (pure — no writes)', () => {
  _test('happy path: plan to a different drive, zero filesystem writes', () => {
    const fake = makeFake({ devOf: (p) => (p.startsWith('/mnt/d') ? 2 : 1), free: 1e12 });
    const plan = storage.buildMigrationPlan({
      what: 'data', dataHome: '/src/.khy', toRoot: '/mnt/d',
      deps: { fsImpl: fake.fsImpl, platform: 'linux' },
    });
    _expect(plan.ok).toBeTruthy();
    _expect(plan.targetRoot).toBe('/mnt/d');
    _expect(plan.items[0].target).toBe(path.join('/mnt/d', '.khy'));
    _expect(plan.items[0].files).toBe(2);
    _expect(plan.items[0].bytes).toBe(20);
    _expect(fake.mutated.length).toBe(0); // PURE: planner wrote nothing
  });

  _test('rejects SAME_DRIVE (source and target on one physical volume)', () => {
    const fake = makeFake({ devOf: () => 1, free: 1e12 });
    const plan = storage.buildMigrationPlan({
      what: 'data', dataHome: '/src/.khy', toRoot: '/mnt/d',
      deps: { fsImpl: fake.fsImpl, platform: 'linux' },
    });
    _expect(plan.ok).toBeFalsy();
    _expect(plan.reason).toBe('NOTHING_TO_MIGRATE');
    _expect(plan.items[0].reason).toBe('SAME_DRIVE');
  });

  _test('rejects INSUFFICIENT_SPACE', () => {
    const fake = makeFake({ devOf: (p) => (p.startsWith('/mnt/d') ? 2 : 1), free: 5 });
    const plan = storage.buildMigrationPlan({
      what: 'data', dataHome: '/src/.khy', toRoot: '/mnt/d',
      deps: { fsImpl: fake.fsImpl, platform: 'linux' },
    });
    _expect(plan.ok).toBeFalsy();
    _expect(plan.reason).toBe('INSUFFICIENT_SPACE');
  });

  _test('rejects TARGET_NOT_WRITABLE', () => {
    const fake = makeFake({ devOf: (p) => (p.startsWith('/mnt/d') ? 2 : 1), free: 1e12, writable: false });
    const plan = storage.buildMigrationPlan({
      what: 'data', dataHome: '/src/.khy', toRoot: '/mnt/d',
      deps: { fsImpl: fake.fsImpl, platform: 'linux' },
    });
    _expect(plan.ok).toBeFalsy();
    _expect(plan.reason).toBe('TARGET_NOT_WRITABLE');
  });

  _test('skips TARGET_EXISTS (never clobbers a non-empty target)', () => {
    const fake = makeFake({ devOf: (p) => (p.startsWith('/mnt/d') ? 2 : 1), free: 1e12, targetHasContent: true });
    const plan = storage.buildMigrationPlan({
      what: 'data', dataHome: '/src/.khy', toRoot: '/mnt/d',
      deps: { fsImpl: fake.fsImpl, platform: 'linux' },
    });
    _expect(plan.ok).toBeFalsy();
    _expect(plan.items[0].reason).toBe('TARGET_EXISTS');
  });

  _test('NO_TARGET when no --to and no usable non-system drive', () => {
    const fake = makeFake({ devOf: () => 1, free: 1e12, drives: [] });
    const plan = storage.buildMigrationPlan({
      what: 'data', dataHome: '/src/.khy',
      deps: { fsImpl: fake.fsImpl, platform: 'linux' },
    });
    _expect(plan.ok).toBeFalsy();
    _expect(plan.reason).toBe('NO_TARGET');
    _expect(fake.mutated.length).toBe(0);
  });
});

_describe('storage.executeMigration + rollback (real fs)', () => {
  const SAVE = ['KHY_DATA_HOME', 'KHY_LOCATION_FILE', 'KHY_OS_ROOT', 'KHY_PROJECT_DATA_HOME'];
  let saved;
  let tmp;

  _beforeEach(() => {
    saved = {};
    for (const k of SAVE) { saved[k] = process.env[k]; delete process.env[k]; }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-migrate-'));
    process.env.KHY_LOCATION_FILE = path.join(tmp, '.location.json');
    dh._resetStorageCaches();
  });

  _afterEach(() => {
    for (const k of SAVE) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    dh._resetStorageCaches();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  _test('copies + verifies + flips the pointer, then rolls back to the source', async () => {
    const src = path.join(tmp, 'src', '.khy');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'note.txt'), 'hello');
    const targetRoot = path.join(tmp, 'drive');
    fs.mkdirSync(targetRoot, { recursive: true });
    const target = path.join(targetRoot, '.khy');

    const plan = {
      ok: true,
      targetRoot,
      items: [{ kind: 'data', source: src, target, bytes: 5, files: 1, ok: true }],
    };

    const res = storage.executeMigration(plan);
    _expect(res.ok).toBeTruthy();
    _expect(fs.existsSync(path.join(target, 'note.txt'))).toBeTruthy(); // copied
    _expect(fs.existsSync(path.join(src, 'note.txt'))).toBeTruthy();    // source kept as backup

    let ptr = dh._readPointer();
    _expect(ptr.dataHome).toBe(target);
    _expect(ptr.previous.dataHome).toBe(src); // rollback breadcrumb stashed

    // Rollback restores the previous pointer and clears the breadcrumb.
    await storage.handleStorageMigrate([], { rollback: true });
    ptr = dh._readPointer();
    _expect(ptr.dataHome).toBe(src);
    _expect(ptr.previous.dataHome).toBeFalsy();
  });

  _test('aborts and leaves the pointer unchanged when verification fails', () => {
    const src = path.join(tmp, 'src2', '.khy');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'data');
    const target = path.join(tmp, 'drive2', '.khy');

    // Claim more files than the source actually has → verify must fail.
    const plan = {
      ok: true,
      targetRoot: path.join(tmp, 'drive2'),
      items: [{ kind: 'data', source: src, target, bytes: 4, files: 99, ok: true }],
    };
    const res = storage.executeMigration(plan);
    _expect(res.ok).toBeFalsy();
    _expect(dh._readPointer()).toBe(null); // pointer never written
  });
});
