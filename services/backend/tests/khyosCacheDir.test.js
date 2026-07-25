'use strict';

/**
 * Resolution tests for khyosCacheDir() — the single cache root that the ISO,
 * builder, qemu, and native build-toolchain provisioners all hang off.
 *
 * The kernel and its build toolchain are khyos *base* artifacts, so the canonical
 * home moved from the legacy khyquant app data home (~/.khyquant/khyos) to the
 * base home (~/.khyos/cache). To avoid stranding hundreds of MB of already-cached
 * downloads on existing machines, a populated legacy dir keeps serving until the
 * canonical dir exists (established-wins). KHY_KHYOS_CACHE_DIR overrides both.
 *
 * os.homedir() ignores $HOME on some platforms, so we monkeypatch it (the
 * provisioner calls os.homedir() on the shared module object at call time).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { khyosCacheDir } = require('@khy/shared/runtime/khyos');

let tmpHome;
let realHomedir;
let savedOverride;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-home-'));
  realHomedir = os.homedir;
  os.homedir = () => tmpHome;
  savedOverride = process.env.KHY_KHYOS_CACHE_DIR;
  delete process.env.KHY_KHYOS_CACHE_DIR;
});

afterEach(() => {
  os.homedir = realHomedir;
  if (savedOverride === undefined) delete process.env.KHY_KHYOS_CACHE_DIR;
  else process.env.KHY_KHYOS_CACHE_DIR = savedOverride;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const canonical = () => path.join(tmpHome, '.khyos', 'cache');
const legacy = () => path.join(tmpHome, '.khyquant', 'khyos');
const seed = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'khy-os-kernel.iso'), 'x');
};

describe('khyosCacheDir resolution', () => {
  test('KHY_KHYOS_CACHE_DIR override wins over everything', () => {
    process.env.KHY_KHYOS_CACHE_DIR = path.join(tmpHome, 'custom');
    seed(legacy()); // even with a populated legacy present, the override wins
    assert.equal(khyosCacheDir(), path.join(tmpHome, 'custom'));
  });

  test('fresh machine (neither dir exists) → canonical ~/.khyos/cache', () => {
    assert.equal(khyosCacheDir(), canonical());
  });

  test('established-wins: populated legacy, no canonical → legacy', () => {
    seed(legacy());
    assert.equal(khyosCacheDir(), legacy());
  });

  test('once canonical exists, it wins even if legacy is still populated', () => {
    seed(legacy());
    fs.mkdirSync(canonical(), { recursive: true });
    assert.equal(khyosCacheDir(), canonical());
  });

  test('an empty legacy dir does not capture resolution → canonical', () => {
    fs.mkdirSync(legacy(), { recursive: true }); // exists but empty
    assert.equal(khyosCacheDir(), canonical());
  });
});
