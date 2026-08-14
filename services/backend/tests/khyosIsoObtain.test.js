'use strict';

/**
 * Tests for the prebuilt-ISO obtain path in ensureKhyosIso — the cheapest, most
 * stable way to get a bootable KHY OS on a bare host: download one verified ISO
 * instead of provisioning a toolchain and compiling.
 *
 *   - KHY_KERNEL_ISO_URL (+ KHY_KERNEL_ISO_SHA256) downloads + verifies an operator
 *     ISO, taking precedence over the manifest pin.
 *   - An env URL without a sha256 is refused (integrity cannot be checked).
 *   - The manifest pin path benefits from mirror failover (resolveArtifactUrls).
 *
 * Hermetic: preferLocal:false skips the dev repo build; KHY_KHYOS_CACHE_DIR points
 * the cache at a throwaway dir; the downloader is injected (no network).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { ensureKhyosIso } = require('@khy/shared/runtime/khyos/isoProvisioner');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

let tmp;
const ISOLATED = [
  'KHY_KERNEL_ISO', 'KHY_KERNEL_ISO_URL', 'KHY_KERNEL_ISO_SHA256',
  'KHY_KHYOS_CACHE_DIR', 'KHY_KHYOS_MANIFEST', 'KHY_KHYOS_OFFLINE', 'KHY_KHYOS_MIRROR_BASE',
];
let saved;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-obtain-'));
  saved = {};
  for (const k of ISOLATED) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.KHY_KHYOS_CACHE_DIR = path.join(tmp, 'cache');
});
afterEach(() => {
  for (const k of ISOLATED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ensureKhyosIso — prebuilt obtain', () => {
  test('KHY_KERNEL_ISO_URL + SHA256 downloads and verifies the ISO', async () => {
    const iso = Buffer.from('FAKE-ISO-BYTES');
    process.env.KHY_KERNEL_ISO_URL = 'https://host.invalid/khy-os-kernel.iso';
    process.env.KHY_KERNEL_ISO_SHA256 = sha256(iso);
    let gotUrl = null;
    const downloader = async (url, dest) => { gotUrl = url; fs.writeFileSync(dest, iso); };

    const out = await ensureKhyosIso({ preferLocal: false, downloader });
    assert.equal(gotUrl, 'https://host.invalid/khy-os-kernel.iso');
    assert.deepEqual(fs.readFileSync(out), iso);
  });

  test('KHY_KERNEL_ISO_URL without a sha256 is refused', async () => {
    process.env.KHY_KERNEL_ISO_URL = 'https://host.invalid/khy-os-kernel.iso';
    await assert.rejects(
      ensureKhyosIso({ preferLocal: false, downloader: async () => {} }),
      /KHY_KERNEL_ISO_SHA256 is missing/,
    );
  });

  test('a corrupt env-URL download fails verification (no ISO returned)', async () => {
    process.env.KHY_KERNEL_ISO_URL = 'https://host.invalid/khy-os-kernel.iso';
    process.env.KHY_KERNEL_ISO_SHA256 = sha256(Buffer.from('expected'));
    const downloader = async (url, dest) => fs.writeFileSync(dest, Buffer.from('tampered'));
    await assert.rejects(
      ensureKhyosIso({ preferLocal: false, downloader }),
      /SHA256 mismatch/,
    );
  });

  test('manifest ISO pin fails over across mirrors', async () => {
    const iso = Buffer.from('MANIFEST-ISO');
    const manifest = {
      filename: 'khy-os-kernel.iso', version: '0.2.0',
      url: 'https://primary.invalid/khy-os-kernel.iso',
      mirrors: ['https://mirror.invalid/khy-os-kernel.iso'],
      sha256: sha256(iso),
    };
    const mp = path.join(tmp, 'm.json');
    fs.writeFileSync(mp, JSON.stringify(manifest));
    process.env.KHY_KHYOS_MANIFEST = mp;

    const downloader = async (url, dest) => {
      if (url.includes('primary')) throw new Error('HTTP 404');
      fs.writeFileSync(dest, iso);
    };
    const out = await ensureKhyosIso({ preferLocal: false, downloader });
    assert.deepEqual(fs.readFileSync(out), iso);
  });
});
