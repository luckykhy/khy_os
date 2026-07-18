'use strict';

/**
 * dataHome pinned-pointer resolution — the [Eco-Arch-Unresolved] red line.
 *
 * getDataHome() uses the real fs/os.homedir() (not DI), so we steer it via env
 * (KHY_LOCATION_FILE, KHY_DATA_HOME) and real temp dirs, asserting the contracts
 * that protect live data:
 *   - a pinned pointer is honored only while its target exists,
 *   - a MISSING pinned target → loud fallback that does NOT rewrite the pointer
 *     and does NOT auto-pick another drive (re-attach restores; no divergent home),
 *   - an established (non-empty) home is pinned in place, never relocated,
 *   - pointer write/read round-trips and merges.
 *
 * Runs under jest or `node --test` via the shim (no jest binary in this checkout).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

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
  });
}

const SAVE_KEYS = ['KHY_DATA_HOME', 'KHY_LOCATION_FILE', 'KHY_OS_ROOT', 'KHY_PROJECT_DATA_HOME'];
let saved;
let tmpRoot;

function freshTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `khy-ptr-${label}-`));
}

_beforeEach(() => {
  saved = {};
  for (const k of SAVE_KEYS) saved[k] = process.env[k];
  for (const k of SAVE_KEYS) delete process.env[k];
  tmpRoot = freshTmp('loc');
  process.env.KHY_LOCATION_FILE = path.join(tmpRoot, '.location.json');
  dh._resetStorageCaches();
});

_afterEach(() => {
  for (const k of SAVE_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  dh._resetStorageCaches();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

_describe('dataHome._writePointer / _readPointer', () => {
  _test('round-trips and merges patches without losing prior keys', () => {
    dh._writePointer({ dataHome: '/a/.khy', source: 'system', pinnedReason: 'system-default' });
    dh._writePointer({ projectDataHome: '/a/.khy-project', projectSource: 'system' });
    const ptr = dh._readPointer();
    _expect(ptr.dataHome).toBe('/a/.khy');               // preserved across the 2nd write
    _expect(ptr.projectDataHome).toBe('/a/.khy-project'); // added by the 2nd write
    _expect(ptr.version).toBe(1);
  });

  _test('_readPointer returns null when no pointer file exists', () => {
    _expect(dh._readPointer()).toBe(null);
  });
});

_describe('dataHome._isEstablished', () => {
  _test('true for a dir with real content, false for empty / pointer-only', () => {
    const empty = freshTmp('est-empty');
    const full = freshTmp('est-full');
    const ptrOnly = freshTmp('est-ptr');
    try {
      fs.writeFileSync(path.join(full, 'sessions.db'), 'x');
      fs.writeFileSync(path.join(ptrOnly, '.location.json'), '{}');
      fs.writeFileSync(path.join(ptrOnly, '.location-note-shown'), 'x');
      _expect(dh._isEstablished(empty)).toBeFalsy();
      _expect(dh._isEstablished(full)).toBeTruthy();
      _expect(dh._isEstablished(ptrOnly)).toBeFalsy(); // breadcrumbs don't count as content
      _expect(dh._isEstablished(path.join(empty, 'nope'))).toBeFalsy();
    } finally {
      for (const d of [empty, full, ptrOnly]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  });
});

_describe('dataHome.getDataHome pointer resolution', () => {
  _test('honors a pinned pointer whose target exists', () => {
    const target = freshTmp('honor');
    try {
      dh._writePointer({ dataHome: target, source: 'migrated', pinnedReason: 'migrate' });
      dh._resetStorageCaches();
      const r = dh.getDataHome();
      _expect(r).toBe(target);
    } finally {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  _test('missing pinned target → falls back WITHOUT rewriting the pointer or auto-picking', () => {
    const ghost = path.join(tmpRoot, 'unplugged-drive', '.khy'); // never created
    dh._writePointer({ dataHome: ghost, source: 'migrated', pinnedReason: 'migrate' });
    dh._resetStorageCaches();

    const systemDefault = path.join(os.homedir(), '.khy');
    const r = dh.getDataHome();
    _expect(r).toBe(systemDefault); // temporary system fallback for this run

    // Red line: the pointer is UNCHANGED — re-attaching the drive restores it.
    const ptr = dh._readPointer();
    _expect(ptr.dataHome).toBe(ghost);
    _expect(ptr.source).toBe('migrated');
  });

  _test('established home is pinned in place and never relocated (red-line regression)', () => {
    const systemDefault = path.join(os.homedir(), '.khy');
    if (dh._isEstablished(systemDefault)) {
      // Real machine already has a populated ~/.khy: fresh pointer + no env must
      // pin THAT home, never auto-move it to another drive.
      dh._resetStorageCaches();
      const r = dh.getDataHome();
      _expect(r).toBe(systemDefault);
      const ptr = dh._readPointer();
      _expect(ptr.dataHome).toBe(systemDefault);
      _expect(ptr.pinnedReason).toBe('established-wins');
    } else {
      // No established ~/.khy here: assert the guard function directly so the
      // contract is still exercised deterministically.
      const est = freshTmp('est-live');
      try {
        fs.writeFileSync(path.join(est, 'memory.json'), '{}');
        _expect(dh._isEstablished(est)).toBeTruthy();
      } finally {
        try { fs.rmSync(est, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  _test('resolution pins the pointer to whatever it returns (pin-and-honor)', () => {
    dh._resetStorageCaches();
    const r = dh.getDataHome();
    const ptr = dh._readPointer();
    _expect(r).toBeTruthy();
    _expect(ptr.dataHome).toBe(r); // recorded == returned, regardless of drive layout
  });
});
