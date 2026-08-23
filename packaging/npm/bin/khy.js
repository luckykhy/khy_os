#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const bundle = path.resolve(__dirname, '..', 'bundled', 'runtime', 'khy', 'bundle.mjs');

// Tell the CLI which console entry the user actually typed. Without this the
// bundle sees argv[1] === '.../bundle.mjs', getInvokedBinary() in
// services/backend/bin/khy.js recognises neither 'khy' nor 'khyquant', and its
// fallback lands on 'khyquant' -- which diverts every system subcommand into
// "`khyquant` is only for launching the quant app". The pip launcher already
// sets this (platform/khy_platform/cli.py); the npm channel must too, or a
// global install can run --version and nothing else.
//
// This package publishes only system entry points (bin: khy, khy-os), so 'khy'
// is the truthful default. A pre-set value wins, which keeps the quant launcher
// able to speak for itself when it wraps this shim.
const env = { ...process.env };
if (!env.KHYQUANT_INVOKED_AS) env.KHYQUANT_INVOKED_AS = 'khy';

const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

if (result.error) {
  console.error(`khy failed to start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status == null ? 1 : result.status;
}
