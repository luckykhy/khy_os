#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const source = path.join(root, 'dist', 'modules', 'khy', 'bundle.mjs');
const destination = path.join(root, 'platform', 'khy_platform', 'bundled', 'runtime', 'khy', 'bundle.mjs');

const build = spawnSync(process.execPath, [
  path.join(root, 'packaging', 'build', 'esbuild-modules.js'),
  '--module', 'khy', '--prod',
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status == null ? 1 : build.status);

fs.rmSync(path.join(root, 'platform', 'khy_platform', 'bundled'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
console.log(`[pip:assemble] ${path.relative(root, destination)}`);
