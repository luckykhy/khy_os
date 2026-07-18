#!/usr/bin/env node
'use strict';

/**
 * khyos-console.js — manual acceptance harness for the KHY OS runner (Phase 1).
 *
 * Bridges your terminal directly to the bare-metal kernel running under QEMU:
 * stdin → kernel serial input, kernel serial output → stdout. Proves the
 * KhyOsRunner end to end without any TUI/frontend layer.
 *
 *   node services/backend/scripts/khyos-console.js [--disk] [--iso <path>]
 *
 *   --disk         attach a persistent KhyFS disk (~/.khyquant/khyos/disks/console.img)
 *   --iso <path>   use a specific ISO (else KHY_KERNEL_ISO / kernel/build / cache / download)
 *
 * Try inside: help / ps / ls /bin / run /bin/forkwait.elf
 * With --disk: write /disk/x hi  → quit → re-run → cat /disk/x  (persists)
 * Quit the console with Ctrl-]  (then Enter).
 */

const os = require('os');
const path = require('path');
const { KhyOsRunner, ensureKhyosIso, khyosCacheDir } = require('@khy/shared/runtime/khyos');

function parseArgs(argv) {
  const out = { disk: false, iso: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--disk') out.disk = true;
    else if (argv[i] === '--iso') out.iso = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const isoPath = args.iso || (await ensureKhyosIso());
  const diskPath = args.disk
    ? path.join(khyosCacheDir(), 'disks', 'console.img')
    : null;

  console.error(`[khyos-console] ISO:  ${isoPath}`);
  if (diskPath) console.error(`[khyos-console] disk: ${diskPath}`);
  console.error('[khyos-console] booting QEMU… (Ctrl-] then Enter to quit)\n');

  const runner = new KhyOsRunner({ isoPath, diskPath });

  runner.on('data', (buf) => process.stdout.write(buf));
  runner.on('error', (err) => console.error(`\n[khyos-console] error: ${err.message}`));
  runner.on('exit', ({ code, signal }) => {
    console.error(`\n[khyos-console] QEMU exited (code=${code} signal=${signal})`);
    process.exit(code || 0);
  });

  await runner.start();
  console.error('[khyos-console] connected.\n');

  // Raw stdin → kernel serial. Ctrl-] (0x1d) quits the console.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', async (buf) => {
    if (buf.length === 1 && buf[0] === 0x1d) {
      console.error('\n[khyos-console] quitting…');
      await runner.stop();
      process.exit(0);
    }
    try {
      await runner.write(buf);
    } catch (err) {
      console.error(`\n[khyos-console] write failed: ${err.message}`);
    }
  });

  const shutdown = async () => {
    try { await runner.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[khyos-console] fatal: ${err.message}`);
  process.exit(1);
});
