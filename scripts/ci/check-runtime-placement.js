#!/usr/bin/env node
/**
 * @pattern Template Method, Visitor
 *
 * check-runtime-placement.js — 守住「生产 runtime 里只有跑起来必需的东西」这条线。
 *
 *   node scripts/ci/check-runtime-placement.js               # 违规则 exit 1
 *   node scripts/ci/check-runtime-placement.js --json        # 机器可读
 *   node scripts/ci/check-runtime-placement.js --root <dir>  # 另查指定 staging
 *
 * 查的是**磁盘上已组装好的 runtime 目录**，不是版本库。理由和
 * check-build-artifacts 正好相反：那边的事故是产物被 git 跟踪，这边的事故是
 * 产物被**发出去**——source map 泄露全部源码，`.khy`/`.db` 泄露用户数据和密钥，
 * 而这两样都不会经过 git，只会经过 `npm pack` 和便携包。
 *
 * 另外单查一条 git 看不见的东西：bundle 末尾的 `//# sourceMappingURL=`。发布
 * 产物里没有 .map 文件，留着那行就是指向空气的引用——调试器和 Sentry 一类工具
 * 会照着去取、拿到 404，把「符号没上传」伪装成「符号损坏」。宁可明确没有，
 * 不要假装有。
 *
 * 判定逻辑全在纯叶子 scripts/lib/runtimePlacementGuard.js；本文件只负责走盘。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const guard = require('../lib/runtimePlacementGuard');

const ROOT = path.resolve(__dirname, '..', '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

/**
 * 默认只查**分发暂存目录**：这里的每个文件都会被原样打进 npm tarball。
 *
 * 刻意不查 dist/modules。那是 esbuild 的公共输出目录，开发构建和生产构建
 * 共用同一个路径，而开发构建本来就该产 map（本地调试全靠它）。把它列进来，
 * 门禁会在每个人跑一次普通构建之后变红——那不是发现问题，那是教人绕过门禁。
 * 发布脚本要查自己的 staging，用 --root 显式传进来。
 *
 * 目录不存在不算失败：本仓大部分时候没构建过，门禁不能因此把 CI 变红；
 * 要拦的是「构建了、而且脏」。
 */
const DEFAULT_RUNTIME_ROOTS = Object.freeze([
  'packaging/npm/bundled/runtime',
  // pip 通道的同位物。它比 npm 通道更需要这道门：assemble 之后只有
  // audit_pip_artifacts.py，而那个审的是打好的 wheel/sdist，不是这份 staging。
  'platform/khy_platform/bundled/runtime',
]);

/** --root <path> 可重复，用于发布/便携脚本检查自己的临时 staging。 */
function rootsFromArgv(args) {
  const extra = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) extra.push(args[++i]);
  }
  return extra.length > 0 ? extra : DEFAULT_RUNTIME_ROOTS.slice();
}

/** 递归列出相对 root 的 posix 路径。走盘失败返回空数组而不抛。 */
function listFiles(absRoot) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(absRoot, '');
  return out;
}

/**
 * 找出末尾仍带 sourceMappingURL、但同目录没有对应 .map 的 bundle。
 *
 * 只读末尾 4 KiB：bundle 有 19 MB，为了一行注释整份读进内存没有必要。
 */
function danglingMapRefs(absRoot, relFiles) {
  const dangling = [];
  for (const rel of relFiles) {
    if (!/\.(mjs|js|cjs)$/.test(rel)) continue;
    const abs = path.join(absRoot, rel);
    let tail = '';
    try {
      const size = fs.statSync(abs).size;
      const start = Math.max(0, size - 4096);
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        tail = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const match = tail.match(/\/\/# sourceMappingURL=(.+)\s*$/);
    if (!match) continue;
    const target = match[1].trim();
    // data: URI 是内联 map，自带内容，不算悬空。
    if (target.startsWith('data:')) continue;
    const targetAbs = path.resolve(path.dirname(abs), target);
    if (!fs.existsSync(targetAbs)) {
      dangling.push({ path: rel, target });
    }
  }
  return dangling;
}

function main() {
  const roots = [];
  for (const relRoot of rootsFromArgv(argv)) {
    const absRoot = path.join(ROOT, relRoot);
    if (!fs.existsSync(absRoot)) {
      roots.push({ root: relRoot, present: false, result: null, dangling: [] });
      continue;
    }
    const files = listFiles(absRoot);
    roots.push({
      root: relRoot,
      present: true,
      // 路径按 runtime 根相对化后再判：否则 `dist/` 这一段会让 nested-build
      // 规则把整个 dist/modules 判成「产物里又嵌了产物」。
      result: guard.inspect(files),
      dangling: danglingMapRefs(absRoot, files),
    });
  }

  if (asJson) {
    console.log(JSON.stringify({ roots }, null, 2));
  } else {
    for (const entry of roots) {
      if (!entry.present) {
        console.log('· ' + entry.root + '：未构建，跳过');
        continue;
      }
      console.log(entry.root + '：');
      console.log(guard.render(entry.result));
      for (const item of entry.dangling) {
        console.log('  ✗ ' + item.path + ' 末尾仍指向 ' + item.target + '，而该文件不在产物里');
        console.log('      悬空的 sourceMappingURL 会让调试器拿到 404，'
          + '把「符号没上传」伪装成「符号损坏」。');
      }
    }
  }

  const failed = roots.some((entry) => entry.present
    && ((entry.result && entry.result.violations.length > 0) || entry.dangling.length > 0));
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { listFiles, danglingMapRefs, rootsFromArgv, DEFAULT_RUNTIME_ROOTS };
