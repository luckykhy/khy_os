'use strict';

/**
 * Builder-toolchain provisioner for bare-Windows kernel builds.
 *
 * The kernel ISO is produced by the Linux toolchain (`make iso` → grub-mkrescue
 * + xorriso), which has no usable native-Windows binary. To compile without WSL
 * or Docker, `khy os build` can boot a small Linux builder appliance under QEMU
 * and run the unchanged `make iso` inside it. This module fetches the two
 * heavy assets that path needs, both fail-soft and sha256-pinned, reusing the
 * same download/verify/atomic-cache primitive as the ISO provisioner:
 *
 *   - ensureBuilderAppliance() → the prebuilt Linux builder qcow2.
 *   - ensurePortableQemu()     → a portable QEMU when none is on PATH (Windows).
 *
 * Contract: every function returns null on ANY failure (no pinned entry, offline,
 * download/checksum error, extraction failure) and never throws — the build
 * cascade degrades to the next rung (download a prebuilt ISO, then a guide).
 *
 * Set KHY_KHYOS_OFFLINE=1 to forbid all network access (every function → null).
 */

const fsDefault = require('fs');
const path = require('path');

const { ensurePinnedArtifact, resolveMirrorUrl } = require('./_artifact');
const { khyosCacheDir } = require('./isoProvisioner');

const APPLIANCE_FILENAME = 'khyos-builder.qcow2';

function manifestPath() {
  return process.env.KHY_KHYOS_MANIFEST || path.join(__dirname, 'khyos-manifest.json');
}

function loadManifest(fs = fsDefault) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
  } catch {
    return null;
  }
}

/** True when network access is forbidden — every provisioner short-circuits. */
function offline() {
  return process.env.KHY_KHYOS_OFFLINE === '1';
}

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

/**
 * Ensure the Linux builder appliance qcow2 is cached locally; return its path or
 * null (fail-soft). Caches under <khyosCacheDir>/builder/<filename> — the exact
 * location `khyos.js:_qemuBuilderImage` already resolves, so no second lookup.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifest]  inject the parsed manifest (skip disk read)
 * @param {Function} [opts.downloader] (url, dest, opts) => Promise<void> test seam
 * @param {object} [opts.fs=require('fs')]
 * @param {string} [opts.cacheDir]  override the builder cache dir
 * @returns {Promise<string|null>}
 */
async function ensureBuilderAppliance(opts = {}) {
  const fs = opts.fs || fsDefault;
  const manifest = opts.manifest || loadManifest(fs);
  const entry = manifest && manifest.builderAppliance;
  if (!entry || !entry.url || !entry.sha256) return null; // not pinned → degrade
  if (offline()) return null;

  const cacheDir = opts.cacheDir || path.join(khyosCacheDir(), 'builder');
  try {
    return await ensurePinnedArtifact({
      cacheDir,
      filename: entry.filename || APPLIANCE_FILENAME,
      url: resolveMirrorUrl(entry),
      sha256: entry.sha256,
      downloader: opts.downloader,
      fs,
    });
  } catch {
    return null; // fail-soft: any download/checksum/lock error → next cascade rung
  }
}

/**
 * Ensure a portable QEMU for the current platform is cached + extracted; return
 * { systemBin, imgBin, dir } or null (fail-soft). Lets a bare-Windows host run
 * the QEMU build path without a system QEMU install.
 *
 * The archive is a multi-file QEMU build (zip/tar). Node has no built-in unzip,
 * so extraction shells out to a `tar`-compatible tool (Windows 10+ bundles
 * bsdtar as `tar`); the spawn is injectable + fail-soft.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifest]
 * @param {Function} [opts.downloader]
 * @param {object} [opts.fs=require('fs')]
 * @param {Function} [opts.spawnSync] inject child_process.spawnSync (test seam)
 * @param {string} [opts.platformKey] override `${platform}-${arch}` (test seam)
 * @param {string} [opts.cacheDir]
 * @returns {Promise<{systemBin: string, imgBin: string, dir: string}|null>}
 */
async function ensurePortableQemu(opts = {}) {
  const fs = opts.fs || fsDefault;
  const manifest = opts.manifest || loadManifest(fs);
  const key = opts.platformKey || platformKey();
  const entry = manifest && manifest.qemu && manifest.qemu[key];
  if (!entry || !entry.url || !entry.sha256) return null;
  if (offline()) return null;

  const baseDir = opts.cacheDir || path.join(khyosCacheDir(), 'qemu', key);
  const systemRel = entry.systemBinRelPath;
  if (!systemRel) return null;
  const systemBin = path.join(baseDir, systemRel);
  const imgBin = entry.imgBinRelPath ? path.join(baseDir, entry.imgBinRelPath) : '';

  // Already extracted from a prior run?
  try {
    if (fs.existsSync(systemBin)) return { systemBin, imgBin, dir: baseDir };
  } catch {
    return null;
  }

  let archive;
  try {
    archive = await ensurePinnedArtifact({
      cacheDir: baseDir,
      filename: entry.filename || `qemu-${key}.archive`,
      url: resolveMirrorUrl(entry),
      sha256: entry.sha256,
      downloader: opts.downloader,
      fs,
    });
  } catch {
    return null;
  }

  // Extract in place. `tar` reads both .zip (bsdtar) and .tar.* archives.
  const spawnSync = opts.spawnSync || require('child_process').spawnSync;
  try {
    const r = spawnSync('tar', ['-xf', archive, '-C', baseDir], { stdio: 'ignore' });
    if (!r || r.error || r.status !== 0) return null;
  } catch {
    return null;
  }

  try {
    return fs.existsSync(systemBin) ? { systemBin, imgBin, dir: baseDir } : null;
  } catch {
    return null;
  }
}

/**
 * Report whether a portable QEMU is actually pinned for this platform — i.e.
 * whether `ensurePortableQemu()` could ever auto-download one. True ONLY when
 * `manifest.qemu[<platform>-<arch>]` carries both a `url` and a `sha256`. With
 * the empty placeholder pin the wheel ships today this is false, so callers must
 * NOT promise "auto-downloaded on first run" — that download can never happen
 * and the claim only misleads users who hit the missing-QEMU error.
 *
 * Fail-soft + side-effect-free: never downloads, never throws; any read/parse
 * error → false (treat as "not armed", the safe, honest default). Mirrors the
 * exact gate `ensurePortableQemu()` applies at lines `!entry.url || !entry.sha256`.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifest]     inject the parsed manifest (skip disk read)
 * @param {string} [opts.platformKey]  override `${platform}-${arch}` (test seam)
 * @param {object} [opts.fs=require('fs')]
 * @returns {boolean}
 */
function isPortableQemuPinned(opts = {}) {
  try {
    const fs = opts.fs || fsDefault;
    const manifest = opts.manifest || loadManifest(fs);
    const key = opts.platformKey || platformKey();
    const entry = manifest && manifest.qemu && manifest.qemu[key];
    return !!(entry && entry.url && entry.sha256 && entry.systemBinRelPath);
  } catch {
    return false;
  }
}

module.exports = {
  ensureBuilderAppliance,
  ensurePortableQemu,
  isPortableQemuPinned,
  APPLIANCE_FILENAME,
};
