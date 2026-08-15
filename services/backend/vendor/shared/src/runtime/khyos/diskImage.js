'use strict';

/**
 * Disk-image helper for KHY OS.
 *
 * The kernel's KhyFS persists to an ATA disk on the primary master. QEMU backs
 * that with a raw image file passed via `-drive ...,format=raw,if=ide`. A raw
 * image is simply a fixed-length, zero-filled file: KhyFS formats it on first
 * boot by writing its own superblock at LBA0 and reuses it across runs so
 * `/disk` survives reboots — matching the `make run-disk` target in
 * kernel/Makefile.
 *
 * Because a raw image needs no header or metadata, we create it natively with
 * Node `fs` (a sparse file truncated to the target size) instead of shelling out
 * to `qemu-img create -f raw`. This removes qemu-img from the run path entirely —
 * running the kernel then needs only `qemu-system-x86_64`, which KhyOsRunner
 * auto-provisions when absent (see builderProvisioner.ensurePortableQemu).
 *
 * IMPORTANT: KhyFS writes the superblock at LBA0, which QEMU's raw-format
 * autodetection would otherwise guard. KhyOsRunner therefore attaches the image
 * with an explicit `-drive file=...,format=raw,if=ide` rather than `-hda` (see
 * the memory note on this exact pitfall).
 */

const fs = require('fs');
const path = require('path');

/** KhyFS's default image size; also the historical `qemu-img create … 16M`. */
const DEFAULT_SIZE = '16M';
const DEFAULT_SIZE_BYTES = 16 * 1024 * 1024;

/**
 * Resolve the qemu-img executable, honoring an explicit override. Retained for
 * `khy os doctor` and backward compatibility; raw-image creation no longer needs
 * it (see ensureDiskImage below).
 */
function resolveQemuImg() {
  return process.env.KHY_QEMU_IMG || 'qemu-img';
}

/**
 * Parse a qemu-img-style size spec into bytes. Accepts a bare byte count
 * (`16777216`) or a `K`/`M`/`G` suffix (`16M`, case-insensitive, binary units to
 * match `qemu-img`). Anything malformed falls back to the 16M default rather than
 * throwing — disk sizing must never crash a boot.
 *
 * @param {string|number} [size]
 * @returns {number} size in bytes (>= 1)
 */
function parseSizeSpec(size = DEFAULT_SIZE) {
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
    return Math.floor(size);
  }
  const m = /^\s*(\d+)\s*([kKmMgG])?\s*$/.exec(String(size));
  if (!m) return DEFAULT_SIZE_BYTES;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIZE_BYTES;
  const mult = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
  const unit = m[2] ? mult[m[2].toLowerCase()] : 1;
  return n * unit;
}

/**
 * Ensure a raw disk image exists at `diskPath`, creating it once if absent.
 * Returns the path. Creates a sparse, zero-filled file of the requested size with
 * Node `fs` (no external tool) — equivalent to `qemu-img create -f raw`. Throws
 * with an actionable message only on a genuine filesystem error; the caller
 * (runner) surfaces it.
 *
 * @param {string} diskPath - absolute path to the .img file
 * @param {string|number} [size='16M'] - size spec (bare bytes or K/M/G suffix)
 * @returns {string} diskPath
 */
function ensureDiskImage(diskPath, size = DEFAULT_SIZE) {
  if (fs.existsSync(diskPath)) return diskPath;

  fs.mkdirSync(path.dirname(diskPath), { recursive: true });

  const bytes = parseSizeSpec(size);
  // Build into a temp sibling then rename, so a concurrent/aborted create never
  // leaves a half-sized image that KhyFS would mis-format.
  const tmpPath = `${diskPath}.${process.pid}.partial`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.ftruncateSync(fd, bytes); // sparse zero-fill to the exact length
  } catch (err) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw new Error(`failed to create KHY OS disk image at ${diskPath}: ${err.message}`);
  }
  try { fs.closeSync(fd); } catch { /* ignore */ }

  try {
    fs.renameSync(tmpPath, diskPath);
  } catch (err) {
    // Another process may have won the race and created it first — accept that.
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    if (fs.existsSync(diskPath)) return diskPath;
    throw new Error(`failed to finalize KHY OS disk image at ${diskPath}: ${err.message}`);
  }
  return diskPath;
}

module.exports = { ensureDiskImage, resolveQemuImg, parseSizeSpec };
