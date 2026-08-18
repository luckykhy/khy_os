'use strict';

/**
 * KHY OS ISO provisioner.
 *
 * Resolves a bootable kernel ISO for the runner, in priority order:
 *   1. KHY_KERNEL_ISO env override (absolute path) — highest priority.
 *   2. Local dev build: <repo>/kernel/build/khy-os-kernel.iso (kernel/Makefile
 *      ISO target). Present on machines that ran `make -C kernel iso`.
 *   3. Cache: ~/.khyos/cache/<filename> (legacy ~/.khyquant/khyos still read) from
 *      a prior download.
 *   4. On-demand download pinned in the manifest (url + sha256), verified and
 *      cached. The wheel ships only this manifest — never the ISO itself.
 *
 * Mirrors services/backend/src/services/runtimeProvisioner.js (sha256 verify,
 * cross-process lock, mirror/proxy env), but is self-contained: @khy/shared must
 * not depend on services/backend, and carries no axios dependency, so download
 * uses Node's built-in https with redirect handling.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveArtifactUrls, ensurePinnedArtifact } = require('./_artifact');

const ISO_FILENAME = 'khy-os-kernel.iso';

function log(msg) {
  if (process.env.KHY_RUNTIME_PROVISION_DEBUG === '1' || process.env.KHY_DEBUG === '1') {
    try {
      console.error(`[khyos-iso] ${msg}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resolve the khyos runtime cache root (ISO, builder, qemu, and toolchain caches
 * all hang off this). The kernel and its build toolchain are khyos *base* layer
 * artifacts — not khyquant app data — so the canonical home is the base home
 * ~/.khyos/cache. Resolution order:
 *   1. KHY_KHYOS_CACHE_DIR — explicit override, highest priority.
 *   2. Legacy established-wins: when the canonical dir does not exist yet but a
 *      populated legacy ~/.khyquant/khyos is present, keep serving it so existing
 *      machines never re-download the hundreds of MB of cached artifacts.
 *   3. Canonical ~/.khyos/cache — the fresh-install default.
 */
function khyosCacheDir() {
  if (process.env.KHY_KHYOS_CACHE_DIR) return process.env.KHY_KHYOS_CACHE_DIR;
  const home = os.homedir();
  const canonical = path.join(home, '.khyos', 'cache');
  const legacy = path.join(home, '.khyquant', 'khyos');
  try {
    // readdirSync throws if legacy is absent → caught → canonical.
    if (!fs.existsSync(canonical) && fs.readdirSync(legacy).length > 0) {
      return legacy;
    }
  } catch {
    /* legacy absent/unreadable → fall through to canonical */
  }
  return canonical;
}

/** Hard cap on the upward walk in repoKernelIso (bundle roots sit ≤7 levels up). */
const KERNEL_PROBE_MAX_DEPTH = 12;

/**
 * Locate a locally-built kernel ISO by walking upward from `fromDir` (default:
 * this module's directory) and returning the first `<ancestor>/kernel/build/
 * <ISO_FILENAME>` that exists, or null when none is found (so the caller falls
 * through to cache/download).
 *
 * A fixed `..` depth was wrong: @khy/shared ships at TWO different depths in the
 * pip wheel — platform/packages/shared (kernel root 6 levels up) and
 * services/backend/vendor/shared (kernel root 7 levels up). The backend resolves
 * the vendor copy, so the old hardcoded 6-level jump landed in
 * `<bundle>/services/` instead of the bundle root, and an ISO freshly built by
 * `khy os build` (which correctly lands it at `<bundle>/kernel/build/`) was
 * never discovered → "No KHY OS ISO available". Walking upward resolves both
 * wheel copies and the symlinked dev layout without guessing depth.
 *
 * Honors KHY_KERNEL_SRC_DIR — the same kernel-source override `khy os build`
 * uses — so a custom build location stays in sync with discovery.
 *
 * @param {string} [fromDir=__dirname] starting directory for the upward walk
 * @returns {string|null} absolute path to a built ISO, or null
 */
function repoKernelIso(fromDir = __dirname) {
  try {
    const srcOverride = process.env.KHY_KERNEL_SRC_DIR;
    if (srcOverride) {
      const iso = path.join(srcOverride, 'build', ISO_FILENAME);
      return fs.existsSync(iso) ? iso : null;
    }
    let dir = path.resolve(fromDir);
    for (let i = 0; i < KERNEL_PROBE_MAX_DEPTH; i++) {
      const iso = path.join(dir, 'kernel', 'build', ISO_FILENAME);
      if (fs.existsSync(iso)) return iso;
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached the filesystem root
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function manifestPath() {
  return process.env.KHY_KHYOS_MANIFEST || path.join(__dirname, 'khyos-manifest.json');
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
  } catch (err) {
    log(`manifest load failed: ${err.message}`);
    return null;
  }
}

/**
 * Ensure a KHY OS ISO is available locally and return its absolute path.
 *
 * Never silently substitutes — if no local build, cache, or pinned source is
 * available it throws with an actionable message (build locally or set
 * KHY_KERNEL_ISO).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.preferLocal=true] - probe <repo>/kernel/build first
 * @param {(url: string, dest: string) => Promise<void>} [opts.downloader] - test seam
 * @returns {Promise<string>} absolute path to a bootable ISO
 */
async function ensureKhyosIso(opts = {}) {
  const { preferLocal = true, downloader } = opts;

  // 1. Explicit override.
  const override = process.env.KHY_KERNEL_ISO;
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new Error(`KHY_KERNEL_ISO points at a missing file: ${override}`);
  }

  // 2. Local dev build.
  if (preferLocal) {
    const local = repoKernelIso();
    if (local) {
      log(`using local build: ${local}`);
      return local;
    }
  }

  // 3. Cache fast-path.
  const cacheDir = khyosCacheDir();
  const manifest = loadManifest();
  const filename = (manifest && manifest.filename) || ISO_FILENAME;
  const cached = path.join(cacheDir, filename);
  if (fs.existsSync(cached)) {
    log(`using cached ISO: ${cached}`);
    return cached;
  }

  // 4. On-demand download (sha256-pinned, cross-process locked, atomic rename,
  //    retry + mirror failover). An env-provided URL wins over the manifest pin,
  //    so operators can host a prebuilt ISO without editing the manifest — the
  //    cheapest, most stable path on a bare Windows host (one verified download
  //    instead of provisioning a 6-tool toolchain and compiling).
  const envUrl = String(process.env.KHY_KERNEL_ISO_URL || '').trim();
  const envSha = String(process.env.KHY_KERNEL_ISO_SHA256 || '').trim();
  if (envUrl) {
    if (!envSha) {
      throw new Error(
        'KHY_KERNEL_ISO_URL is set but KHY_KERNEL_ISO_SHA256 is missing. Set it to the ' +
          'ISO\'s sha256 (e.g. `sha256sum khy-os-kernel.iso`) so the download can be ' +
          'verified, or use KHY_KERNEL_ISO with a local path instead.'
      );
    }
    log(`obtaining ISO from KHY_KERNEL_ISO_URL: ${envUrl}`);
    return ensurePinnedArtifact({ cacheDir, filename, url: envUrl, sha256: envSha, downloader, log });
  }

  const urls = resolveArtifactUrls(manifest); // primary + any manifest mirrors
  if (!urls.length || !manifest.sha256) {
    throw new Error(
      'No KHY OS ISO available: not found in kernel/build or the cache, and no ' +
        'download is pinned in the manifest. Build it from the bundled kernel ' +
        'source with `khy os build` (it lands the ISO where this auto-discovers ' +
        'it), set KHY_KERNEL_ISO to an existing ISO path, or set KHY_KERNEL_ISO_URL ' +
        '+ KHY_KERNEL_ISO_SHA256 to download a prebuilt one.'
    );
  }

  return ensurePinnedArtifact({
    cacheDir,
    filename,
    urls,
    sha256: manifest.sha256,
    downloader,
    log,
  });
}

module.exports = { ensureKhyosIso, khyosCacheDir, ISO_FILENAME, repoKernelIso };
