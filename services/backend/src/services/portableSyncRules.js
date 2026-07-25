'use strict';

/**
 * portableSyncRules.js — Rule constants for `khy portable sync`.
 *
 * Single home for every include/exclude/protection list used by the portable
 * sync engine (portableSyncService.js). Kept separate so the CLI handler,
 * the engine and the scripts/ thin wrapper all share ONE rule source and a
 * future rule tweak is a one-file edit (Zero Hardcoding / SSOT).
 *
 * Name patterns support a single leading '*' wildcard (e.g. '*.db',
 * '*_history'); everything else is an exact, case-insensitive name match.
 */

// Directories never read from the source tree (runtime data, caches, build
// artefacts, VCS). Aligned with run-portable.bat's exclusion list, PLUS the
// runtime-data directories it misses (.khy / .khyquant-data / sweeps).
const EXCLUDE_DIRS = [
  '.git',
  '__pycache__',
  '.tmp',
  'dist',
  'node_modules', // gated separately via package-lock hash (see service)
  '.khy',
  '.khyquant-data',
  '.khy_orphan_sweep',
  '.khy-Trajectory',
  'sessions',
  'logs',
  '.sync-state',
  'coverage',
  '.cache',
];

// Files never copied from the source tree (databases, debug logs, manifest).
const EXCLUDE_FILES = [
  '*.db',
  '*.db-shm',
  '*.db-wal',
  '_debug.log',
  '.sync-manifest.json',
];

// Target-side protection list: paths matching these are NEVER written to and
// NEVER deleted on the portable copy, in ANY mode (including --mirror). This
// is what keeps the portable copy's local data alive across syncs.
const PROTECTED_TARGET_DIRS = [
  '.khyquant-data',
  '.khy',
  '.khy-Trajectory',
  'logs',
  '*_history',
  '.env',
  '.env.local',
  'node_modules', // mirrored separately, only when the lock hash changed
];

// Lock files whose SHA256 gates the (expensive) node_modules mirror step.
const DEP_LOCK_FILES = [
  'services/backend/package-lock.json',
];

// Source-side health gate: each file must pass `node --check` before we are
// allowed to push code to the portable copy (never ship broken entrypoints).
const CRITICAL_ENTRY_FILES = [
  'services/backend/bin/khy.js',
  'services/backend/src/cli/router.js',
];

// Manifest file name written at the target root after a successful sync.
const MANIFEST_FILE = '.sync-manifest.json';

module.exports = {
  EXCLUDE_DIRS,
  EXCLUDE_FILES,
  PROTECTED_TARGET_DIRS,
  DEP_LOCK_FILES,
  CRITICAL_ENTRY_FILES,
  MANIFEST_FILE,
};
