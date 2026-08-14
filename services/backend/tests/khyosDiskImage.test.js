'use strict';

/**
 * Tests for the native raw disk-image helper (diskImage.js). A KhyFS disk is a
 * fixed-length zero-filled file attached as `-drive ...,format=raw,if=ide`, so it
 * is created with Node `fs` (openSync + ftruncateSync) — NO `qemu-img`. These
 * assert size parsing, exact byte length, no-overwrite idempotence, and that
 * creation spawns zero external processes (the whole point: removing qemu-img
 * from the run path, which was the user's `qemu-img not found` error).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

const {
  ensureDiskImage,
  resolveQemuImg,
  parseSizeSpec,
} = require('../../../platform/packages/shared/src/runtime/khyos/diskImage');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-disk-'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('parseSizeSpec', () => {
  test('binary K/M/G suffixes (case-insensitive)', () => {
    assert.equal(parseSizeSpec('16M'), 16 * 1024 * 1024);
    assert.equal(parseSizeSpec('32m'), 32 * 1024 * 1024);
    assert.equal(parseSizeSpec('1G'), 1024 * 1024 * 1024);
    assert.equal(parseSizeSpec('4K'), 4 * 1024);
  });

  test('bare byte count', () => {
    assert.equal(parseSizeSpec('1048576'), 1048576);
    assert.equal(parseSizeSpec(2048), 2048);
  });

  test('default is 16M', () => {
    assert.equal(parseSizeSpec(), 16 * 1024 * 1024);
  });

  test('malformed / non-positive falls back to 16M (never throws)', () => {
    const SIXTEEN_M = 16 * 1024 * 1024;
    assert.equal(parseSizeSpec('not-a-size'), SIXTEEN_M);
    assert.equal(parseSizeSpec('0'), SIXTEEN_M);
    assert.equal(parseSizeSpec(-5), SIXTEEN_M);
    assert.equal(parseSizeSpec(''), SIXTEEN_M);
    assert.equal(parseSizeSpec('16MB'), SIXTEEN_M); // unsupported suffix → default
  });
});

describe('ensureDiskImage', () => {
  test('creates a raw file of the exact requested byte length', () => {
    const disk = path.join(tmp, 'a', 'disk.img');
    const out = ensureDiskImage(disk, '16M');
    assert.equal(out, disk);
    assert.ok(fs.existsSync(disk));
    assert.equal(fs.statSync(disk).size, 16 * 1024 * 1024);
  });

  test('default size is 16M', () => {
    const disk = path.join(tmp, 'default.img');
    ensureDiskImage(disk);
    assert.equal(fs.statSync(disk).size, 16 * 1024 * 1024);
  });

  test('leaves the first bytes zero-filled (KhyFS formats LBA0 itself)', () => {
    const disk = path.join(tmp, 'zero.img');
    ensureDiskImage(disk, '4K');
    const head = fs.readFileSync(disk).subarray(0, 512);
    assert.ok(head.every((b) => b === 0));
  });

  test('does not overwrite an existing image', () => {
    const disk = path.join(tmp, 'keep.img');
    fs.writeFileSync(disk, Buffer.from('SUPERBLOCK-PRESERVED'));
    const before = fs.readFileSync(disk);
    ensureDiskImage(disk, '16M');
    const after = fs.readFileSync(disk);
    assert.deepEqual(after, before); // untouched — no re-truncation
  });

  test('creates zero external processes (no qemu-img)', () => {
    // Trip-wire: any spawn/exec during creation fails the test.
    const spies = ['spawnSync', 'spawn', 'execSync', 'execFileSync', 'exec', 'execFile'];
    const saved = {};
    for (const k of spies) {
      saved[k] = child_process[k];
      child_process[k] = () => { throw new Error(`unexpected child_process.${k} during disk creation`); };
    }
    try {
      const disk = path.join(tmp, 'pure.img');
      ensureDiskImage(disk, '8M');
      assert.equal(fs.statSync(disk).size, 8 * 1024 * 1024);
    } finally {
      for (const k of spies) child_process[k] = saved[k];
    }
  });

  test('no leftover .partial temp file after success', () => {
    const disk = path.join(tmp, 'clean.img');
    ensureDiskImage(disk, '4K');
    const siblings = fs.readdirSync(path.dirname(disk));
    assert.ok(!siblings.some((f) => f.includes('.partial')), `stray temp: ${siblings}`);
  });
});

describe('resolveQemuImg', () => {
  test('honors KHY_QEMU_IMG override, else default name', () => {
    const saved = process.env.KHY_QEMU_IMG;
    try {
      delete process.env.KHY_QEMU_IMG;
      assert.equal(resolveQemuImg(), 'qemu-img');
      process.env.KHY_QEMU_IMG = '/opt/qemu/qemu-img';
      assert.equal(resolveQemuImg(), '/opt/qemu/qemu-img');
    } finally {
      if (saved === undefined) delete process.env.KHY_QEMU_IMG;
      else process.env.KHY_QEMU_IMG = saved;
    }
  });
});
