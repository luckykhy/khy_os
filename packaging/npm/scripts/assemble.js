#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const npmRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(npmRoot, '..', '..');
const sourceBundle = path.join(repoRoot, 'dist', 'modules', 'khy', 'bundle.mjs');
const targetBundle = path.join(npmRoot, 'bundled', 'runtime', 'khy', 'bundle.mjs');

const build = spawnSync(process.execPath, [
  path.join(repoRoot, 'packaging', 'build', 'esbuild-modules.js'),
  '--module', 'khy', '--prod',
], {
  cwd: repoRoot,
  stdio: 'inherit',
  windowsHide: true,
});
if (build.status !== 0) process.exit(build.status == null ? 1 : build.status);

fs.rmSync(path.join(npmRoot, 'bundled'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(targetBundle), { recursive: true });
fs.copyFileSync(sourceBundle, targetBundle);
console.log(`[npm:assemble] ${path.relative(npmRoot, targetBundle)}`);
