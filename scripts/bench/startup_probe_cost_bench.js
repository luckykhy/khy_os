#!/usr/bin/env node
'use strict';

// Cross-platform startup-probe COST benchmark — the missing half of the
// Windows-vs-Linux startup story.
//
// The other bench scripts (git_spawn_bench, hw_probe_spawn_bench,
// startup_spawn_bench) prove the caches remove N process spawns from the
// blocking `khy chat` startup path — a platform-independent COUNT. What they
// cannot show from a Linux box is the per-spawn WALL-CLOCK on Windows, where
// each CreateProcess + Defender scan (and especially a PowerShell cold-start)
// costs far more than a Linux fork.
//
// This script measures that wall-clock directly by timing the ACTUAL processes
// the three caches eliminate, on whatever OS runs it:
//   • check_node cache            → `node --version`
//   • workspaceGitInit shell-free → `git rev-parse` (execSync adds cmd.exe on Win)
//   • hardware-probe cache        → swap probe: `free`/`sysctl`/PowerShell CIM
//                                   + `nvidia-smi` (skipped honestly if absent)
// and contrasts it with the warm alternative (a single small JSON file read).
//
// Run it on ubuntu-latest AND windows-latest (see
// .github/workflows/startup-benchmark.yml) and compare the two logs: the same
// probes, timed on each real OS, quantify the gap the caches close on Windows.
//
// Usage:  node scripts/bench/startup_probe_cost_bench.js [--runs N]

const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const isWin = os.platform() === 'win32';
const runsArg = process.argv.indexOf('--runs');
const RUNS = runsArg >= 0 ? parseInt(process.argv[runsArg + 1], 10) || 9 : 9;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Time a thunk; return ms. Returns null if it throws (probe unavailable).
function timeOnce(fn) {
  const t0 = process.hrtime.bigint();
  try {
    fn();
  } catch {
    return null;
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Median wall-clock of a real spawn over RUNS iterations. `execSync` (string,
// shell) is used where the production code uses execSync so the cmd.exe tax on
// Windows is included; `firstColdMs` captures the first iteration separately
// because Defender's first-touch scan (and PowerShell cold JIT) is pricier.
function benchSpawn(label, command, opts) {
  const samples = [];
  let firstColdMs = null;
  for (let i = 0; i < RUNS; i++) {
    const ms = timeOnce(() => cp.execSync(command, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15000, ...opts }));
    if (ms === null) return { label, available: false };
    if (i === 0) firstColdMs = ms;
    samples.push(ms);
  }
  return { label, available: true, medianMs: median(samples), firstColdMs, command };
}

// The warm alternative: what the caches do instead of spawning — read a small
// JSON blob from disk. This is the steady-state cost the caches replace the
// spawns with.
function benchWarmRead() {
  const tmp = path.join(os.tmpdir(), `khy-warm-probe-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ signature: 'x', cpuInfo: { hasAvx2: true }, gpu: null, swap: { totalMB: 0 } }));
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    samples.push(timeOnce(() => JSON.parse(fs.readFileSync(tmp, 'utf-8'))));
  }
  try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  return { label: 'warm cache read (JSON)', available: true, medianMs: median(samples) };
}

function swapProbeCommand() {
  if (isWin) {
    return 'powershell -NoProfile -Command "(Get-CimInstance Win32_PageFileUsage | '
      + 'Measure-Object -Property AllocatedBaseSize,CurrentUsage -Sum).Sum -join \',\'"';
  }
  if (os.platform() === 'darwin') return 'sysctl -n vm.swapusage';
  return 'free -m | grep Swap';
}

function main() {
  const nodeCmd = isWin ? 'node --version' : 'node --version';
  const gitCmd = 'git rev-parse --show-toplevel';
  const gpuNull = isWin ? 'NUL' : '/dev/null';

  const probes = [
    benchSpawn('node --version  (check_node cache)', nodeCmd),
    benchSpawn('git rev-parse   (workspaceGitInit)', gitCmd),
    benchSpawn('swap probe      (hardware-probe cache)', swapProbeCommand()),
    benchSpawn('nvidia-smi      (hardware-probe cache)', `nvidia-smi --query-gpu=name --format=csv,noheader 2>${gpuNull}`),
  ];
  const warm = benchWarmRead();

  console.log(`platform=${os.platform()} arch=${os.arch()} cpus=${os.cpus().length} runs=${RUNS}`);
  console.log(`node=${process.version}`);
  console.log('── per-spawn wall-clock of the processes the caches ELIMINATE ──────────');
  let coldSum = 0;
  let counted = 0;
  for (const p of probes) {
    if (!p.available) {
      console.log(`  ${p.label.padEnd(40)} : (unavailable on this host — skipped)`);
      continue;
    }
    coldSum += p.medianMs;
    counted += 1;
    console.log(`  ${p.label.padEnd(40)} : median ${p.medianMs.toFixed(2)} ms  (first/cold ${p.firstColdMs.toFixed(2)} ms)`);
  }
  console.log('── warm alternative (what the caches do instead) ──────────────────────');
  console.log(`  ${warm.label.padEnd(40)} : median ${warm.medianMs.toFixed(3)} ms`);
  console.log('───────────────────────────────────────────────────────────────────────');
  console.log(`  COLD startup-probe cost (${counted} spawns) : ~${coldSum.toFixed(2)} ms/launch`);
  console.log(`  WARM startup-probe cost (0 spawns)      : ~${warm.medianMs.toFixed(3)} ms/launch`);
  console.log(`  → caches remove ~${(coldSum - warm.medianMs).toFixed(2)} ms of PROCESS-SPAWN work per launch on this OS.`);
  console.log('  Compare this line between the ubuntu-latest and windows-latest CI runs:');
  console.log('  the same probes, timed on each real OS, quantify the Windows startup gap.');

  // Machine-readable line for CI aggregation / job summaries.
  const json = {
    platform: os.platform(),
    runs: RUNS,
    coldProbeMs: Number(coldSum.toFixed(3)),
    warmProbeMs: Number(warm.medianMs.toFixed(3)),
    savedMs: Number((coldSum - warm.medianMs).toFixed(3)),
    probes: probes.map((p) => ({ label: p.label, available: p.available, medianMs: p.medianMs ?? null, firstColdMs: p.firstColdMs ?? null })),
  };
  console.log(`RESULT_JSON ${JSON.stringify(json)}`);
}

main();
