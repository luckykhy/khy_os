#!/usr/bin/env node
'use strict';

/**
 * run-ink-tui-tests.js — cross-platform launcher for the Ink TUI render suite.
 *
 * The `ink` package is ESM-only and inkRuntime.loadInk() bridges it with a
 * dynamic import(). Jest can only honor that dynamic import when node is started
 * with --experimental-vm-modules, which must be present BEFORE the process boots
 * (setting process.env at runtime is too late). NODE_OPTIONS is the portable way
 * to inject it, but `NODE_OPTIONS=... jest` inline syntax is not valid in Windows
 * cmd shells — hence this wrapper, which spawns jest with the flag set in the
 * child environment regardless of platform.
 *
 * Used by: `npm run --workspace backend test:tui` and the CI "Ink TUI" job.
 * Extra CLI args are forwarded to jest, e.g. `npm run test:tui -- --watch`.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
// jest's package "exports" hides ./bin/jest.js from require.resolve, so locate it
// via the (exported) package.json + its bin field — robust under hoisting too.
const jestPkgPath = require.resolve('jest/package.json', { paths: [backendRoot] });
const jestBin = path.join(path.dirname(jestPkgPath), require(jestPkgPath).bin);

const env = { ...process.env };
const flag = '--experimental-vm-modules';
env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag;

const args = [jestBin, 'tests/tui', '--runInBand', ...process.argv.slice(2)];

const result = spawnSync(process.execPath, args, {
  cwd: backendRoot,
  env,
  stdio: 'inherit',
});

process.exit(result.status == null ? 1 : result.status);
