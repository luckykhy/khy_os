'use strict';

/**
 * Unit tests for the bare-Windows builder provisioners and the shared
 * pinned-artifact primitive they reuse:
 *
 *   - @khy/shared/runtime/khyos/builderProvisioner  (ensureBuilderAppliance,
 *     ensurePortableQemu) — both fail-soft (null on any failure), offline-aware,
 *     sha256-pinned, with injected downloader/spawnSync/manifest seams.
 *   - @khy/shared/runtime/khyos/_artifact            (ensurePinnedArtifact) —
 *     download → verify → atomic-rename → cross-process lock, THROWS on failure.
 *
 * No real network or QEMU is touched: the downloader writes known bytes whose
 * sha256 the manifest pins, and extraction is an injected spawnSync that
 * materializes the expected binary.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  ensureBuilderAppliance,
  ensurePortableQemu,
} = require('@khy/shared/runtime/khyos/builderProvisioner');
const {
  ensurePinnedArtifact,
  sha256File,
  resolveMirrorUrl,
} = require('@khy/shared/runtime/khyos/_artifact');

let tmp;
let savedOffline;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khyos-provision-'));
  savedOffline = process.env.KHY_KHYOS_OFFLINE;
  delete process.env.KHY_KHYOS_OFFLINE;
});
afterEach(() => {
  if (savedOffline === undefined) delete process.env.KHY_KHYOS_OFFLINE;
  else process.env.KHY_KHYOS_OFFLINE = savedOffline;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Downloader that writes the bytes registered per URL basename into `dest`. */
function pinnedDownloader(byBasename) {
  return async (url, dest) => {
    const name = path.basename(String(url));
    if (!(name in byBasename)) throw new Error(`unexpected download: ${name}`);
    fs.writeFileSync(dest, byBasename[name]);
  };
}

describe('ensureBuilderAppliance', () => {
  const applianceBytes = Buffer.from('khyos-builder-appliance');
  const goodManifest = () => ({
    builderAppliance: {
      filename: 'khyos-builder.qcow2',
      url: 'https://example.invalid/khyos-builder.qcow2',
      sha256: sha256(applianceBytes),
    },
  });

  test('null when the manifest has no builderAppliance entry', async () => {
    const r = await ensureBuilderAppliance({ manifest: {}, cacheDir: tmp });
    assert.equal(r, null);
  });

  test('null when the entry is not pinned (empty url/sha256)', async () => {
    const manifest = { builderAppliance: { filename: 'x.qcow2', url: '', sha256: '' } };
    const r = await ensureBuilderAppliance({ manifest, cacheDir: tmp });
    assert.equal(r, null);
  });

  test('null when offline, even with a pinned entry', async () => {
    process.env.KHY_KHYOS_OFFLINE = '1';
    let called = false;
    const r = await ensureBuilderAppliance({
      manifest: goodManifest(), cacheDir: tmp,
      downloader: async () => { called = true; },
    });
    assert.equal(r, null);
    assert.equal(called, false, 'offline must not invoke the downloader');
  });

  test('downloads + verifies + caches the appliance, returns its path', async () => {
    const cacheDir = path.join(tmp, 'builder');
    const out = await ensureBuilderAppliance({
      manifest: goodManifest(), cacheDir,
      downloader: pinnedDownloader({ 'khyos-builder.qcow2': applianceBytes }),
    });
    assert.equal(out, path.join(cacheDir, 'khyos-builder.qcow2'));
    assert.ok(fs.existsSync(out));
    assert.equal(sha256File(out), sha256(applianceBytes));
  });

  test('null on sha256 mismatch (corrupt download), leaves no partial behind', async () => {
    const cacheDir = path.join(tmp, 'builder');
    const out = await ensureBuilderAppliance({
      manifest: goodManifest(), cacheDir,
      downloader: pinnedDownloader({ 'khyos-builder.qcow2': Buffer.from('tampered') }),
    });
    assert.equal(out, null);
    assert.equal(fs.existsSync(path.join(cacheDir, 'khyos-builder.qcow2')), false);
    // No leftover .partial files.
    const leftovers = fs.existsSync(cacheDir)
      ? fs.readdirSync(cacheDir).filter((f) => f.includes('.partial'))
      : [];
    assert.deepEqual(leftovers, []);
  });

  test('null when the downloader throws (network error)', async () => {
    const out = await ensureBuilderAppliance({
      manifest: goodManifest(), cacheDir: path.join(tmp, 'builder'),
      downloader: async () => { throw new Error('ECONNRESET'); },
    });
    assert.equal(out, null);
  });
});

describe('ensurePortableQemu', () => {
  const qemuBytes = Buffer.from('portable-qemu-archive');
  const entry = {
    filename: 'qemu-w64-portable.zip',
    url: 'https://example.invalid/qemu-w64-portable.zip',
    sha256: sha256(qemuBytes),
    systemBinRelPath: 'qemu/qemu-system-x86_64.exe',
    imgBinRelPath: 'qemu/qemu-img.exe',
  };
  const manifest = () => ({ qemu: { 'win32-x64': { ...entry } } });

  test('null when no entry for the platform key', async () => {
    const r = await ensurePortableQemu({ manifest: { qemu: {} }, platformKey: 'win32-x64', cacheDir: tmp });
    assert.equal(r, null);
  });

  test('null when offline', async () => {
    process.env.KHY_KHYOS_OFFLINE = '1';
    const r = await ensurePortableQemu({ manifest: manifest(), platformKey: 'win32-x64', cacheDir: tmp });
    assert.equal(r, null);
  });

  test('returns the cached binary without re-downloading when already extracted', async () => {
    const baseDir = path.join(tmp, 'qemu');
    const systemBin = path.join(baseDir, entry.systemBinRelPath);
    fs.mkdirSync(path.dirname(systemBin), { recursive: true });
    fs.writeFileSync(systemBin, 'already-here');
    let downloaded = false;
    const out = await ensurePortableQemu({
      manifest: manifest(), platformKey: 'win32-x64', cacheDir: baseDir,
      downloader: async () => { downloaded = true; },
      spawnSync: () => ({ status: 0 }),
    });
    assert.ok(out);
    assert.equal(out.systemBin, systemBin);
    assert.equal(downloaded, false, 'an already-extracted QEMU must not re-download');
  });

  test('downloads, extracts via injected spawnSync, returns systemBin/imgBin', async () => {
    const baseDir = path.join(tmp, 'qemu');
    // The injected "tar" extraction materializes the expected binaries.
    const spawnSync = (exe, args) => {
      assert.equal(exe, 'tar');
      assert.ok(args.includes('-xf'));
      const sys = path.join(baseDir, entry.systemBinRelPath);
      const img = path.join(baseDir, entry.imgBinRelPath);
      fs.mkdirSync(path.dirname(sys), { recursive: true });
      fs.writeFileSync(sys, 'qemu-system');
      fs.writeFileSync(img, 'qemu-img');
      return { status: 0 };
    };
    const out = await ensurePortableQemu({
      manifest: manifest(), platformKey: 'win32-x64', cacheDir: baseDir,
      downloader: pinnedDownloader({ 'qemu-w64-portable.zip': qemuBytes }),
      spawnSync,
    });
    assert.ok(out, 'resolution should succeed');
    assert.equal(out.systemBin, path.join(baseDir, entry.systemBinRelPath));
    assert.equal(out.imgBin, path.join(baseDir, entry.imgBinRelPath));
    assert.ok(fs.existsSync(out.systemBin));
  });

  test('null when extraction fails (spawnSync non-zero)', async () => {
    const baseDir = path.join(tmp, 'qemu');
    const out = await ensurePortableQemu({
      manifest: manifest(), platformKey: 'win32-x64', cacheDir: baseDir,
      downloader: pinnedDownloader({ 'qemu-w64-portable.zip': qemuBytes }),
      spawnSync: () => ({ status: 1 }),
    });
    assert.equal(out, null);
  });

  test('null when extraction produces no systemBin', async () => {
    const baseDir = path.join(tmp, 'qemu');
    const out = await ensurePortableQemu({
      manifest: manifest(), platformKey: 'win32-x64', cacheDir: baseDir,
      downloader: pinnedDownloader({ 'qemu-w64-portable.zip': qemuBytes }),
      spawnSync: () => ({ status: 0 }), // extracts nothing
    });
    assert.equal(out, null);
  });
});

describe('_artifact.ensurePinnedArtifact', () => {
  const bytes = Buffer.from('pinned-artifact-bytes');
  const base = { filename: 'artifact.bin', sha256: () => sha256(bytes), url: 'https://example.invalid/artifact.bin' };

  test('returns the cached path on a hit without downloading', async () => {
    const cacheDir = path.join(tmp, 'c');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cached = path.join(cacheDir, base.filename);
    fs.writeFileSync(cached, bytes);
    let called = false;
    const out = await ensurePinnedArtifact({
      cacheDir, filename: base.filename, url: base.url, sha256: sha256(bytes),
      downloader: async () => { called = true; },
    });
    assert.equal(out, cached);
    assert.equal(called, false);
  });

  test('downloads, verifies, atomically renames into place', async () => {
    const cacheDir = path.join(tmp, 'c2');
    const out = await ensurePinnedArtifact({
      cacheDir, filename: base.filename, url: base.url, sha256: sha256(bytes),
      downloader: pinnedDownloader({ 'artifact.bin': bytes }),
    });
    assert.equal(out, path.join(cacheDir, base.filename));
    assert.equal(sha256File(out), sha256(bytes));
  });

  test('throws on sha256 mismatch and cleans the partial', async () => {
    const cacheDir = path.join(tmp, 'c3');
    await assert.rejects(
      ensurePinnedArtifact({
        cacheDir, filename: base.filename, url: base.url, sha256: sha256(bytes),
        downloader: pinnedDownloader({ 'artifact.bin': Buffer.from('wrong') }),
      }),
      /SHA256 mismatch/,
    );
    assert.equal(fs.existsSync(path.join(cacheDir, base.filename)), false);
    const leftovers = fs.readdirSync(cacheDir).filter((f) => f.includes('.partial'));
    assert.deepEqual(leftovers, []);
  });

  test('throws when url/sha256 are not pinned', async () => {
    await assert.rejects(
      ensurePinnedArtifact({ cacheDir: tmp, filename: base.filename, url: '', sha256: '' }),
      /not pinned/,
    );
  });

  test('throws offline on a cache miss without invoking the downloader', async () => {
    process.env.KHY_KHYOS_OFFLINE = '1';
    let called = false;
    await assert.rejects(
      ensurePinnedArtifact({
        cacheDir: path.join(tmp, 'c4'), filename: base.filename, url: base.url, sha256: sha256(bytes),
        downloader: async () => { called = true; },
      }),
      /offline/,
    );
    assert.equal(called, false);
  });
});

describe('_artifact.resolveMirrorUrl', () => {
  let savedMirror;
  beforeEach(() => { savedMirror = process.env.KHY_KHYOS_MIRROR_BASE; delete process.env.KHY_KHYOS_MIRROR_BASE; });
  afterEach(() => {
    if (savedMirror === undefined) delete process.env.KHY_KHYOS_MIRROR_BASE;
    else process.env.KHY_KHYOS_MIRROR_BASE = savedMirror;
  });

  test('null when the entry has no url', () => {
    assert.equal(resolveMirrorUrl({ filename: 'x' }), null);
    assert.equal(resolveMirrorUrl(null), null);
  });

  test('returns the entry url verbatim with no mirror base', () => {
    assert.equal(resolveMirrorUrl({ url: 'https://h/x.iso' }), 'https://h/x.iso');
  });

  test('rehosts under KHY_KHYOS_MIRROR_BASE by filename', () => {
    process.env.KHY_KHYOS_MIRROR_BASE = 'https://mirror.example/khyos/';
    assert.equal(
      resolveMirrorUrl({ url: 'https://h/path/khyos-builder.qcow2', filename: 'khyos-builder.qcow2' }),
      'https://mirror.example/khyos/khyos-builder.qcow2',
    );
  });
});
