'use strict';

/**
 * Honesty guard for the missing-QEMU guidance.
 *
 * Bug fixed: the Windows missing-QEMU error and `khy os doctor` both promised
 * "On Windows it is normally auto-downloaded on first run", but the manifest's
 * `qemu.win32-x64` pin ships EMPTY (url/sha256 blank), so ensurePortableQemu()
 * returns null and NO download is ever attempted. The promise was false — it
 * sent Windows users chasing a retry that can never succeed.
 *
 * These tests lock the contract:
 *   - isPortableQemuPinned() is true ONLY when url+sha256(+systemBinRelPath) are
 *     all present for the host key — and is false for the shipped empty pin.
 *   - qemuInstallHint() only claims auto-download when explicitly told the
 *     download is armed; otherwise it gives the concrete install + PATH path and
 *     never claims "auto-downloaded".
 *
 * Pure functions, no spawn, no network.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SHARED = path.resolve(
  __dirname, '..', '..', '..',
  'platform', 'packages', 'shared', 'src', 'runtime', 'khyos',
);
const { qemuInstallHint } = require(path.join(SHARED, 'KhyOsRunner'));
const { isPortableQemuPinned } = require(path.join(SHARED, 'builderProvisioner'));

describe('isPortableQemuPinned() — auto-download is only "armed" when truly pinned', () => {
  const KEY = 'win32-x64';

  test('false for the shipped empty placeholder pin (url/sha256 blank)', () => {
    const manifest = {
      qemu: { 'win32-x64': { filename: 'q.zip', url: '', sha256: '', systemBinRelPath: 'q/x.exe' } },
    };
    assert.equal(isPortableQemuPinned({ manifest, platformKey: KEY }), false);
  });

  test('false when the platform has no qemu entry at all', () => {
    assert.equal(isPortableQemuPinned({ manifest: { qemu: {} }, platformKey: KEY }), false);
    assert.equal(isPortableQemuPinned({ manifest: {}, platformKey: KEY }), false);
    assert.equal(isPortableQemuPinned({ manifest: null, platformKey: KEY }), false);
  });

  test('false when url present but sha256 missing (and vice-versa)', () => {
    const onlyUrl = { qemu: { 'win32-x64': { url: 'https://x/q.zip', sha256: '', systemBinRelPath: 'q/x.exe' } } };
    const onlySha = { qemu: { 'win32-x64': { url: '', sha256: 'abc', systemBinRelPath: 'q/x.exe' } } };
    assert.equal(isPortableQemuPinned({ manifest: onlyUrl, platformKey: KEY }), false);
    assert.equal(isPortableQemuPinned({ manifest: onlySha, platformKey: KEY }), false);
  });

  test('true only when url + sha256 + systemBinRelPath are all present', () => {
    const armed = {
      qemu: {
        'win32-x64': {
          filename: 'qemu-w64-portable.zip',
          url: 'https://example.test/qemu-w64-portable.zip',
          sha256: 'a'.repeat(64),
          systemBinRelPath: 'qemu/qemu-system-x86_64.exe',
        },
      },
    };
    assert.equal(isPortableQemuPinned({ manifest: armed, platformKey: KEY }), true);
  });

  test('the real shipped manifest is NOT armed (placeholder pin) — regression anchor', () => {
    // Reads the actual manifest on disk for win32-x64. If a maintainer later pins
    // a real portable QEMU this flips to true (and the auto-download promise then
    // becomes honest); until then it must be false.
    assert.equal(isPortableQemuPinned({ platformKey: KEY }), false);
  });
});

describe('qemuInstallHint() — never promises a download that is not armed', () => {
  test('win32 + NOT armed: gives install + PATH, never claims auto-download', () => {
    const hint = qemuInstallHint('win32', { autoDownloadAvailable: false });
    assert.doesNotMatch(hint, /auto-download/i);
    assert.match(hint, /add it to PATH/);
    assert.match(hint, /KHY_QEMU/);
  });

  test('win32 with no opts defaults to NOT armed (honest default)', () => {
    const hint = qemuInstallHint('win32');
    assert.doesNotMatch(hint, /auto-download/i);
    assert.match(hint, /add it to PATH/);
  });

  test('win32 + armed: may promise auto-download (only when truly pinned)', () => {
    const hint = qemuInstallHint('win32', { autoDownloadAvailable: true });
    assert.match(hint, /auto-downloaded on first run/);
    assert.match(hint, /add it to PATH/);
    assert.match(hint, /KHY_QEMU/);
  });

  test('darwin / linux hints are unchanged and platform-correct', () => {
    assert.match(qemuInstallHint('darwin'), /brew install qemu/);
    assert.match(qemuInstallHint('linux'), /apt-get install qemu-system-x86/);
  });
});
