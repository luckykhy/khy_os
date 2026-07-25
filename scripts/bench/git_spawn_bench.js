#!/usr/bin/env node
'use strict';

// Measures the process-spawn footprint of workspaceGitInit's blocking rev-parse
// (the `ensureWorkspaceRepo` probe on repl.js's startup path) with shell-free
// transport ON vs OFF.
//
// On Windows, execSync (OFF) inserts a cmd.exe between the launcher and git.exe
// — an extra CreateProcess per call; spawnSync (ON) spawns git directly. This
// counts shell-mediated vs direct-git invocations so the reduction is
// demonstrable. Run on Windows for the real per-CreateProcess wall-clock.
//
// Usage:  node scripts/bench/git_spawn_bench.js

const cp = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const MOD = path.join(REPO, 'services/backend/src/services/workspaceGitInit.js');
const DET = path.join(REPO, 'services/backend/src/services/gitExecutableDetector.js');

function measure(gate) {
  delete require.cache[require.resolve(MOD)];
  try { require(DET).clearCache(); } catch { /* best effort */ }
  process.env.KHY_GIT_SHELL_FREE = gate;
  const realExec = cp.execSync;
  const realSpawn = cp.spawnSync;
  let execShell = 0;
  let spawnDirect = 0;
  cp.execSync = function (command, opts) {
    if (typeof command === 'string' && command.includes('rev-parse')) execShell++;
    return realExec.call(cp, command, opts);
  };
  cp.spawnSync = function (file, a, opts) {
    if (Array.isArray(a) && a.includes('rev-parse')) spawnDirect++;
    return realSpawn.call(cp, file, a, opts);
  };
  try {
    require(MOD)._git('rev-parse --show-toplevel', REPO);
  } finally {
    cp.execSync = realExec;
    cp.spawnSync = realSpawn;
  }
  return { execShell, spawnDirect };
}

const off = measure('off');
const on = measure('1');
// OFF: launcher -> shell -> git  (2 processes on Windows: cmd.exe + git.exe)
// ON : launcher -> git           (1 process)
const offProcs = off.execShell * 2 + off.spawnDirect;
const onProcs = on.execShell * 2 + on.spawnDirect;
console.log('workspaceGitInit rev-parse (blocking startup probe):');
console.log(`  OFF (execSync) : shell-mediated=${off.execShell} direct-git=${off.spawnDirect}  → ${offProcs} processes/probe (Windows)`);
console.log(`  ON  (spawnSync): shell-mediated=${on.execShell} direct-git=${on.spawnDirect}  → ${onProcs} processes/probe (Windows)`);
console.log(`  → ON removes ${offProcs - onProcs} process/probe (the cmd.exe intermediary) on Windows.`);
