#!/usr/bin/env node
'use strict';

/**
 * assemble.js — 把生产 bundle 组装进 npm 包的 bundled/(挂在 prepack 上)。
 *
 * 组装本身(临时 staging → 布局门禁 → 原子换入)在 scripts/release/lib/runtimeStaging.js，
 * 与 pip 通道共用一份实现。本文件只负责「先构建、再声明组装什么」。
 *
 * 门禁在换入前跑，理由见那个模块的顶部注释：`audit-purity.js` 的禁品清单里没有
 * `*.map`，而 `.map` 里带着全部源码 —— 光靠 prepack 现有的两步拦不住它。
 */

const path = require('path');
const { spawnSync } = require('child_process');

const npmRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(npmRoot, '..', '..');
const { assembleRuntime } = require(path.join(repoRoot, 'scripts', 'release', 'lib', 'runtimeStaging.js'));

const build = spawnSync(process.execPath, [
  path.join(repoRoot, 'packaging', 'build', 'esbuild-modules.js'),
  '--module', 'khy', '--prod',
], {
  cwd: repoRoot,
  stdio: 'inherit',
  windowsHide: true,
});
if (build.status !== 0) process.exit(build.status == null ? 1 : build.status);

try {
  assembleRuntime({
    label: 'npm:assemble',
    bundledDir: path.join(npmRoot, 'bundled'),
    root: npmRoot,
    entries: [
      {
        from: path.join(repoRoot, 'dist', 'modules', 'khy', 'bundle.mjs'),
        to: 'runtime/khy/bundle.mjs',
      },
    ],
  });
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(1);
}
