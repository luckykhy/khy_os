'use strict';

/**
 * verify-runtime-placement.js — offline self-check for "Plan A" manual runtime
 * placement on air-gapped / intranet-only hosts.
 *
 * On hosts that cannot reach the internet, the on-demand provisioner cannot
 * download anything, so operators stage the inference runtimes by hand (copied
 * in over a compliant channel: USB, internal artifact store, etc.). This script
 * verifies that a hand-placed runtime is laid out the way the runtime expects —
 * WITHOUT any network access. It does not download, hash, or mutate anything; it
 * only reads the filesystem and reports.
 *
 * It is the placement counterpart to scripts/release/pin-runtime-binaries.js
 * (which is for the online/mirror workflow). The source of truth for paths and
 * sentinels is runtimeProvisioner.inspect(), so this stays correct as the
 * manifest evolves.
 *
 * Usage:
 *   node scripts/release/verify-runtime-placement.js              Check all runtimes
 *   node scripts/release/verify-runtime-placement.js ollama-runner  Check one runtime
 *
 * Exit code: 0 if every checked runtime's sentinel is present (usable), 1 if any
 * is missing — so it can gate a deployment step in CI / provisioning scripts.
 */

const fs = require('fs');
const path = require('path');

const provisioner = require('../../services/backend/src/services/runtimeProvisioner');

function isExecutable(file) {
  if (process.platform === 'win32') return true; // no POSIX exec bit on Windows
  try {
    return (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function main() {
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;
  const report = provisioner.inspect();

  if (report.error) {
    console.error(`manifest error: ${report.error}`);
    process.exit(2);
  }

  console.log(`platform: ${report.platform}`);
  console.log('');

  let allOk = true;
  let checked = 0;

  for (const rt of report.runtimes) {
    if (filter && rt.name !== filter) continue;
    checked++;

    const sentinelAbs = path.join(rt.targetDir, rt.sentinel);
    const present = fs.existsSync(sentinelAbs);
    const exec = present ? isExecutable(sentinelAbs) : false;

    const mark = present ? (exec ? 'OK ' : 'WARN') : 'MISSING';
    console.log(`[${mark}] ${rt.name}`);
    console.log(`        targetDir: ${rt.targetDir}`);
    console.log(`        sentinel : ${rt.sentinel}  (place the binary here)`);

    if (!present) {
      allOk = false;
      console.log(`        -> sentinel not found; copy the ${report.platform} runtime so that`);
      console.log(`           ${sentinelAbs}`);
      console.log(`           exists. The provisioner's present-check looks for exactly this file.`);
    } else if (!exec) {
      // Not fatal — the launcher still finds it, but POSIX needs the exec bit.
      console.log(`        -> present but not executable; run: chmod +x "${sentinelAbs}"`);
    }
    console.log('');
  }

  if (checked === 0) {
    console.error(filter ? `unknown runtime: ${filter}` : 'no runtimes in manifest');
    process.exit(2);
  }

  if (allOk) {
    console.log('All checked runtimes are present. No download needed — the provisioner');
    console.log('fast-path will use these binaries as-is.');
    process.exit(0);
  } else {
    console.log('Some runtimes are missing. See per-runtime hints above.');
    console.log('After placing the files, re-run this script to confirm.');
    process.exit(1);
  }
}

main();
