#!/usr/bin/env node
'use strict';

// Real-product startup A/B — the decisive Windows-vs-Linux measurement.
//
// The other bench scripts time isolated probe processes or count spawns. This
// one launches the ACTUAL `khy` startup process (services/backend/bin/khy.js ai)
// end-to-end, twice:
//   • BEFORE — the startup-spawn caches OFF (KHY_GIT_SHELL_FREE=0,
//              KHY_HW_PROBE_CACHE=0, hw-probe cache wiped each run) → every
//              launch re-spawns git via a shell intermediary (cmd.exe on
//              Windows) and re-runs the 3 hardware probes.
//   • AFTER  — the caches ON and warm → git spawned directly (no cmd.exe),
//              0 hardware-probe spawns.
//
// On Linux the delta is tiny (fork is cheap). On Windows each eliminated spawn
// is a CreateProcess + Defender scan (and cmd.exe cold-start), so the BEFORE→
// AFTER delta here IS the Windows startup gap these caches close. Run it on the
// Windows machine that feels slow and compare `savedMs` to a Linux run.
//
// Self-contained: only Node core + a working `khy` checkout. No npm install and
// no network. The child reads EOF immediately (no stdin) and exits cleanly; a
// hard timeout guards against a hang.
//
// Usage:  node scripts/bench/startup_ab_bench.js [--runs N] [--timeout-ms M]

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '../..');
// Prefer the in-repo source entry; fall back to a bundled copy if that is what
// the installed product uses (pip/npm layouts ship bundled/services/backend).
const ENTRY_CANDIDATES = [
  path.join(REPO, 'services/backend/bin/khy.js'),
  path.join(REPO, 'platform/khy_os/bundled/services/backend/bin/khy.js'),
];
const ENTRY = ENTRY_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

function argInt(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
const RUNS = argInt('--runs', 9);
const TIMEOUT_MS = argInt('--timeout-ms', 30000);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

// Launch the real product once, timing spawn→exit wall-clock in ms. Returns
// null if it times out (counted separately so a hang never poisons the median).
function launchOnce(env) {
  const t0 = process.hrtime.bigint();
  const res = cp.spawnSync(process.execPath, [ENTRY, 'ai'], {
    // No stdin → the REPL sees EOF and shuts down cleanly (verified on Linux;
    // readline emits 'close' the same way on Windows). stdout/stderr discarded.
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: TIMEOUT_MS,
    env,
    windowsHide: true,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.error && res.error.code === 'ETIMEDOUT') return null;
  return ms;
}

function baseEnv(tmpHome, extra) {
  // Start from a copy of the real environment so the launch is representative,
  // then isolate the data home and pin the gate values under test.
  return Object.assign({}, process.env, { KHY_DATA_HOME: tmpHome }, extra);
}

function bench(label, extra, { wipeHwCacheEachRun }) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ab-'));
  const cacheFile = path.join(tmpHome, 'hw_probe_cache.json');
  try {
    // One warm-up launch (JIT, FS cache) that is not measured. For the ON side
    // this also primes the hw-probe cache so the measured runs are warm.
    launchOnce(baseEnv(tmpHome, extra));
    const samples = [];
    let timeouts = 0;
    for (let i = 0; i < RUNS; i++) {
      if (wipeHwCacheEachRun) { try { fs.unlinkSync(cacheFile); } catch { /* absent */ } }
      const ms = launchOnce(baseEnv(tmpHome, extra));
      if (ms === null) { timeouts += 1; continue; }
      samples.push(ms);
    }
    return { label, medianMs: median(samples), samples, timeouts };
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

function main() {
  if (!ENTRY) {
    console.error('startup_ab_bench: could not find bin/khy.js. Run from a khy checkout.');
    console.error('  looked in:\n    ' + ENTRY_CANDIDATES.join('\n    '));
    process.exit(2);
  }

  console.log(`platform=${os.platform()} arch=${os.arch()} cpus=${os.cpus().length}`);
  console.log(`node=${process.version}  runs=${RUNS}  entry=${path.relative(REPO, ENTRY)}`);
  console.log('Launching the REAL khy startup end-to-end, caches OFF vs ON …');
  console.log('');

  // BEFORE: startup-spawn caches OFF; wipe the hw-probe cache every run so each
  // launch re-pays all three probe spawns + the shell-wrapped git spawns.
  const before = bench('BEFORE  (caches OFF, cold)', {
    KHY_GIT_SHELL_FREE: '0',
    KHY_HW_PROBE_CACHE: '0',
  }, { wipeHwCacheEachRun: true });

  // AFTER: caches ON and warm (the warm-up launch primed the hw-probe cache).
  const after = bench('AFTER   (caches ON, warm)', {
    KHY_GIT_SHELL_FREE: '1',
    KHY_HW_PROBE_CACHE: '1',
  }, { wipeHwCacheEachRun: false });

  const line = (r) => `  ${r.label.padEnd(28)} : median ${r.medianMs == null ? 'n/a' : r.medianMs.toFixed(1) + ' ms'}`
    + (r.timeouts ? `  (${r.timeouts} timeout${r.timeouts > 1 ? 's' : ''})` : '');
  console.log(line(before));
  console.log(line(after));
  console.log('  ' + '─'.repeat(60));

  let savedMs = null;
  let savedPct = null;
  if (before.medianMs != null && after.medianMs != null) {
    savedMs = before.medianMs - after.medianMs;
    savedPct = (savedMs / before.medianMs) * 100;
    console.log(`  → the 4 startup-spawn caches remove ~${savedMs.toFixed(1)} ms `
      + `(${savedPct.toFixed(1)}%) from real cold startup on this OS.`);
  }
  console.log('  On Linux this is ~noise (fork is cheap); on Windows each removed');
  console.log('  spawn is a CreateProcess + Defender scan (+cmd.exe), so a large');
  console.log('  savedMs here IS the Windows startup gap these caches close.');

  const json = {
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    runs: RUNS,
    beforeMs: before.medianMs == null ? null : Number(before.medianMs.toFixed(2)),
    afterMs: after.medianMs == null ? null : Number(after.medianMs.toFixed(2)),
    savedMs: savedMs == null ? null : Number(savedMs.toFixed(2)),
    savedPct: savedPct == null ? null : Number(savedPct.toFixed(2)),
    beforeTimeouts: before.timeouts,
    afterTimeouts: after.timeouts,
  };
  console.log('');
  console.log(`RESULT_JSON ${JSON.stringify(json)}`);
}

main();
