#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const bundle = path.resolve(__dirname, '..', 'bundled', 'runtime', 'khy', 'bundle.mjs');
const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});

if (result.error) {
  console.error(`khy failed to start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status == null ? 1 : result.status;
}
