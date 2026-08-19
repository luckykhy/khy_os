#!/usr/bin/env node
'use strict';

/**
 * assemble-pip-runtime.js — 把生产 bundle 组装进 wheel 的 bundled/。
 *
 * 组装本身(临时 staging → 布局门禁 → 原子换入)在 ./lib/runtimeStaging.js，与
 * npm 通道共用一份实现。本文件只负责「先构建、再声明组装什么」。
 *
 * pip 通道原来比 npm 通道更没有护栏：assemble 之后只有 audit_pip_artifacts.py，
 * 而它审的是打好的 wheel/sdist，不是这份 staging。门禁放在换入前，是这条链上
 * 唯一能在「装进包之前」发现调试符号的位置。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const { assembleRuntime } = require('./lib/runtimeStaging');

const build = spawnSync(process.execPath, [
  path.join(root, 'packaging', 'build', 'esbuild-modules.js'),
  '--module', 'khy', '--prod',
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status == null ? 1 : build.status);

try {
  assembleRuntime({
    label: 'pip:assemble',
    bundledDir: path.join(root, 'platform', 'khy_platform', 'bundled'),
    root,
    entries: [
      {
        from: path.join(root, 'dist', 'modules', 'khy', 'bundle.mjs'),
        to: 'runtime/khy/bundle.mjs',
      },
    ],
  });
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(1);
}
