'use strict';

/**
 * @khy/shared/runtime/khyos — host-side bridge to the bare-metal KHY OS kernel.
 *
 * Consumed identically by the TUI (in-process), the ai-backend /ws session bus,
 * and the pip `khy os` CLI (via Node). The kernel itself is unchanged: this is
 * pure host orchestration of QEMU + its serial socket.
 *
 *   const { KhyOsRunner, ensureKhyosIso } = require('@khy/shared/runtime/khyos');
 *   const iso = await ensureKhyosIso();
 *   const runner = new KhyOsRunner({ isoPath: iso, diskPath });
 *   runner.on('data', (buf) => process.stdout.write(buf));
 *   await runner.start();
 */

const { KhyOsRunner, stripAnsi, qemuInstallHint } = require('./KhyOsRunner');
const { ensureKhyosIso, khyosCacheDir, ISO_FILENAME, repoKernelIso } = require('./isoProvisioner');
const { ensureBuilderAppliance, ensurePortableQemu, isPortableQemuPinned } = require('./builderProvisioner');
const { ensureWindowsBuildToolchain } = require('./toolchainProvisioner');
const { ensureDiskImage, resolveQemuImg } = require('./diskImage');
const { findFreePort } = require('./portUtils');
const { locateSystemQemu, autolocateEnabled: qemuAutolocateEnabled } = require('./qemuLocate');

module.exports = {
  KhyOsRunner,
  ensureKhyosIso,
  ensureBuilderAppliance,
  ensurePortableQemu,
  isPortableQemuPinned,
  locateSystemQemu,
  qemuAutolocateEnabled,
  qemuInstallHint,
  ensureWindowsBuildToolchain,
  ensureDiskImage,
  findFreePort,
  resolveQemuImg,
  khyosCacheDir,
  stripAnsi,
  ISO_FILENAME,
  repoKernelIso,
};
