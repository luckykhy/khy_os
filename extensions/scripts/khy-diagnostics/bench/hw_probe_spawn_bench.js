#!/usr/bin/env node
'use strict';

// Measures the process-spawn footprint of hardwareProfileService.detectProfile()
// — the third `khy chat` startup-spawn reducer — with the cross-launch probe
// cache OFF vs ON (KHY_HW_PROBE_CACHE).
//
// detectProfile() runs three process-spawning probes on the BLOCKING startup
// path (prefetch.js applyLimits, before the mode branch, so `khy chat` pays it):
//   • detectGpu()   → nvidia-smi
//   • detectSwap()  → `free -m` (Linux) / `sysctl` (mac) / PowerShell CIM (Win)
//   • parseCpuInfo()→ `grep /proc/cpuinfo` for AVX2 (Linux only)
// The old in-memory `_cachedProfile` only elides them WITHIN one process, so
// every fresh launch re-paid all three. On Windows each is a full CreateProcess
// + Defender scan (tens of ms). This counts the eliminated spawns (the
// platform-independent root-cause metric) and times them on THIS host.
//
// Usage:  node extensions/scripts/khy-diagnostics/bench/hw_probe_spawn_bench.js [--runs N]

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '../..');
const MOD = path.join(REPO, 'services/backend/src/services/hardwareProfileService.js');

// Isolate the cache into a throwaway data home so a real ~/.khy is never touched
// and cold runs are truly cold.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-hwbench-'));
process.env.KHY_DATA_HOME = TMP;

const PROBE_RE = /nvidia-smi|free -m|swapusage|PageFileUsage|proc\/cpuinfo/;

function freshDetect(gate) {
  // Fresh module instance + cleared in-memory cache = a fresh-process launch.
  // The service captures execSync via destructuring at require time, so the
  // counter must be installed BEFORE require(MOD) to intercept the bound ref.
  delete require.cache[require.resolve(MOD)];
  process.env.KHY_HW_PROBE_CACHE = gate;
  const realExec = cp.execSync;
  let probes = 0;
  cp.execSync = function (command, opts) {
    if (typeof command === 'string' && PROBE_RE.test(command)) probes++;
    return realExec.call(cp, command, opts);
  };
  const t0 = process.hrtime.bigint();
  try {
    const hw = require(MOD);
    hw.resetCache();
    hw.detectProfile();
  } finally {
    cp.execSync = realExec;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { probes, ms };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function main() {
  const runsArg = process.argv.indexOf('--runs');
  const runs = runsArg >= 0 ? parseInt(process.argv[runsArg + 1], 10) || 11 : 11;

  // OFF: every launch re-probes. Wipe the cache file each iteration to force it.
  const offProbes = [];
  const offMs = [];
  for (let i = 0; i < runs; i++) {
    try { fs.unlinkSync(path.join(TMP, 'hw_probe_cache.json')); } catch { /* absent */ }
    const r = freshDetect('0');
    offProbes.push(r.probes);
    offMs.push(r.ms);
  }

  // ON: first launch is cold (spawns + writes cache); subsequent launches are
  // warm (cache hit → zero probe spawns). Measure the warm steady state.
  try { fs.unlinkSync(path.join(TMP, 'hw_probe_cache.json')); } catch { /* absent */ }
  const cold = freshDetect('1'); // primes the disk cache
  const warmProbes = [];
  const warmMs = [];
  for (let i = 0; i < runs; i++) {
    const r = freshDetect('1'); // cache intact → warm
    warmProbes.push(r.probes);
    warmMs.push(r.ms);
  }

  const offP = median(offProbes);
  const warmP = median(warmProbes);
  console.log(`platform=${os.platform()}  hardwareProfile probe-cache benchmark  runs=${runs}`);
  console.log('── detectProfile() startup probes ─────────────────────────────');
  console.log(`  cache OFF (KHY_HW_PROBE_CACHE=0): ${offP} probe-spawn/launch, ${median(offMs).toFixed(3)} ms median`);
  console.log(`  cold  (first launch, ON)        : ${cold.probes} probe-spawn, ${cold.ms.toFixed(3)} ms`);
  console.log(`  warm  (cache hit, ON)           : ${warmP} probe-spawn/launch, ${median(warmMs).toFixed(3)} ms median`);
  console.log(`  → eliminates ${offP - warmP} process spawn/launch once warm (nvidia-smi + swap probe`);
  console.log('    + Linux cpuinfo grep). On Windows each is a full CreateProcess + Defender');
  console.log('    scan (tens of ms); re-run on Windows for the real per-spawn wall-clock.');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
}

main();
