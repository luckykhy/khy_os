#!/usr/bin/env node
'use strict';

/**
 * entries/launch.js — 多端入口的跨平台壳。
 *
 * 为什么根目录需要这么一个壳，而不是让人一律走 `khy`：
 *
 *   1. **跨平台**。`khy` 在 Windows 上的快捷方式是 `khy-cli.bat`，非 Windows 上
 *      要自己去敲 `node services/backend/bin/khy.js`。本文件在任何装了 Node 的平台上
 *      都是同一条命令。
 *   2. **免 Python**。`khy.bat` / `khy.sh` 先探测 Python 3.8+ 才拉起 Node。
 *      没有 Python 的环境里那条路走不通，这条路走得通。
 *   3. **入口在入口处**。端的清单就在本目录旁边，起端的东西也在本目录里，
 *      不必先知道 CLI 装在哪。
 *
 * 它**不重复实现**任何东西：解析、检活、启动三件事都在
 * `services/backend/src/services/entrypoints/` 里，本壳只按 [DESIGN-LAY-005] §2
 * 允许的「进程启动」方式把它拉起来（`L1 → L2` 的唯一允许边就是 spawn，不是 import）。
 * 端清单的真源始终是同一份 `entries/entries.json`。
 *
 * 用法：
 *   node entries/launch.js                      列出全部端
 *   node entries/launch.js status               exe / apk / html 在哪、产出来没有、怎么得到
 *   node entries/launch.js <id>                 启动一个端
 *   node entries/launch.js <id> --build         构建一个端
 *   node entries/launch.js <id> --dry-run       只打印计划，不执行
 *   node entries/launch.js probe [<id>]         检活
 *   node entries/launch.js info <id>            单个端的完整声明
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'services', 'backend', 'bin', 'khy.js');
const MANIFEST = path.join(__dirname, 'entries.json');

function fail(message, hint) {
  console.error(`[ERROR] ${message}`);
  if (hint) console.error(`        ${hint}`);
  process.exitCode = 1;
}

function printUsage() {
  console.log('用法：');
  console.log('  node entries/launch.js                      列出全部端');
  console.log('  node entries/launch.js <id>                 启动一个端');
  console.log('  node entries/launch.js <id> --build         构建一个端');
  console.log('  node entries/launch.js <id> --dry-run       只打印计划，不执行');
  console.log('  node entries/launch.js probe [<id>]         检活（探磁盘与本机工具链）');
  console.log('  node entries/launch.js info <id>            单个端的完整声明');
  console.log('');
  console.log('端清单真源：entries/entries.json');
  console.log('规范文档：  docs/03_DESIGN_设计/[DESIGN-ARCH-117] khy-多端入口矩阵.md');
}

/**
 * 把本壳的参数翻译成 `khy entry` 的子命令。
 * @param {string[]} argv
 * @returns {{ args: string[], action: string }}
 */
function translate(argv) {
  const [first, ...rest] = argv;
  if (!first) return { args: ['list'], action: 'list' };
  if (['list', 'ls'].includes(first)) return { args: ['list', ...rest], action: 'list' };
  if (['probe', 'doctor'].includes(first)) return { args: ['probe', ...rest], action: 'probe' };
  if (['info', 'show'].includes(first)) return { args: ['info', ...rest], action: 'info' };
  if (['status', 'artifacts'].includes(first)) {
    return { args: ['status', ...rest], action: 'status' };
  }

  // 其余形态是「端 id + 开关」：默认启动，带 --build 则构建。
  const wantsBuild = rest.includes('--build');
  const passthrough = rest.filter(arg => arg !== '--build');
  return {
    args: [wantsBuild ? 'build' : 'launch', first, ...passthrough],
    action: wantsBuild ? 'build' : 'launch',
  };
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  // 先确认真源在，否则下面拉起来的 CLI 也只会换个地方报同样的错。
  // 这里只做存在性检查，不解析——解析归 registry.js，本壳不重复实现。
  const fs = require('fs');
  if (!fs.existsSync(MANIFEST)) {
    fail(
      `端清单真源缺失：${MANIFEST}`,
      '本文件必须与 entries.json 同目录；若是分发副本，请整目录一起复制'
    );
    return;
  }
  if (!fs.existsSync(CLI)) {
    fail(
      `CLI 入口缺失：${CLI}`,
      '端矩阵的实现归 services/backend 所有；若这是裁剪过的分发，请改用随包提供的 khy 命令'
    );
    return;
  }

  const { args, action } = translate(argv);
  console.log(`[entries] ${action}：${args.join(' ')}`);

  const child = spawn(process.execPath, [CLI, 'entry', ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: false,
  });

  // 不设超时：端可能长跑（dev server、窗口应用）。何时结束由端自己决定，
  // 这里只负责把它的退出码如实带出去（工程规则 3 / RUNTIME-003）。
  child.on('error', err => {
    fail(`拉起 CLI 失败：${err.message}`, `请确认 ${process.execPath} 可用，再重试`);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      fail(`CLI 被信号 ${signal} 终止（不是本壳杀的）`);
      return;
    }
    process.exitCode = code === null ? 1 : code;
  });
}

main();
