#!/usr/bin/env node
/**
 * ext-run.js —— 把 `npm run <目标>` 派发到**拓展**里的脚本（[DESIGN-ARCH-069] §2.3 / §3.5）。
 *
 * 为什么需要它：`scripts/portable/*` 这类交付脚本按 §1.6 该迁出核，但它们的调用方是
 * `package.json` 的 npm 目标。如果 npm 目标直接写 `node extensions/scripts/khy-portable/
 * build.js`，那么删掉这个拓展目录之后，`npm run portable:build` 报的是一条 node 的
 * `Cannot find module`——用户看到的是崩溃，不是「这个能力没装」。那不叫「删目录即消失」，
 * 那叫删目录即坏掉。
 *
 * 有了这一层，缺失退化成一条说得清的消息 + 非零退出码；命令名与脚本路径的映射写在拓展
 * 自己的 manifest 里，核侧只知道 `<拓展 id> <命令名>` 这一对，不知道任何文件路径。
 *
 * **不 import services/**：按 [DESIGN-ARCH-068] 第二节的禁止边，scripts/ 属横切层，
 * 不许 import L2 的实现。于是这里重复了一份两层目录扫描（与 extensionRoots.discover
 * 同深度）。代价是两份扫描逻辑，收益是交付脚本的派发不会因为后端代码坏掉而一起坏掉——
 * 而修复后端正是这些诊断脚本要干的事。两处的一致性由 scripts/tests/ext-run.test.js 兜住。
 *
 * 用法：node scripts/lib/ext-run.js <拓展 id> <命令名> [透传给脚本的参数...]
 *
 * @module scripts/lib/ext-run
 * @pattern Command, Facade
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MANIFEST = 'khy.extension.json';
const MAX_DEPTH = 2; // 与 extensionRoots.MAX_DEPTH 同值（§2.3：一层分类，不再往下）

function repoRoot() {
  // 覆盖变量只为测试用夹具仓库，生产路径永远是本文件上溯两级。
  return process.env.KHY_EXT_RUN_ROOT
    ? path.resolve(process.env.KHY_EXT_RUN_ROOT)
    : path.resolve(__dirname, '..', '..');
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .filter((n) => !n.startsWith('.') && n !== 'node_modules')
      .sort();
  } catch {
    return [];
  }
}

/**
 * 找一个拓展目录。扫 `extensions/<id>/` 与 `extensions/<分类>/<id>/` 两层。
 *
 * 按**目录名**匹配而不是按 manifest 里的 id：§3.3 规定二者必须相等，而目录名这一侧
 * 不需要读文件就能比对——找不到时也就能明确区分「没这个目录」和「目录在但 manifest 坏了」。
 *
 * @param {string} id - 拓展 id（= 叶子目录名）
 * @returns {{dir: string, manifest: object}|null}
 */
function findExtension(id) {
  const root = path.join(repoRoot(), 'extensions');
  const candidates = [path.join(root, id)];
  for (const category of subdirs(root)) {
    candidates.push(path.join(root, category, id));
  }
  for (const dir of candidates) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
    } catch {
      continue;
    }
    try {
      return { dir, manifest: JSON.parse(raw) };
    } catch (err) {
      // 目录在、manifest 坏 → 这是个**明确的错误**，不该被当作「没装」而继续找下去。
      fail(`拓展 ${id} 的 ${MANIFEST} 不是合法 JSON：${err.message}\n  位置：${dir}`);
    }
  }
  return null;
}

function fail(message) {
  process.stderr.write(`[ext-run] ${message}\n`);
  process.exit(1);
}

function main(argv) {
  const [id, command, ...rest] = argv;
  if (!id || !command) {
    fail('用法：node scripts/lib/ext-run.js <拓展 id> <命令名> [参数...]');
  }

  const found = findExtension(id);
  if (!found) {
    fail(
      `拓展 ${id} 未安装 —— 命令 "${command}" 不可用。\n` +
        `  这不是故障：extensions/ 下没有这个目录，该能力就不存在（[DESIGN-ARCH-069] §4.1）。\n` +
        `  要恢复它：把该拓展目录放回 extensions/<分类>/${id}/，无需任何注册步骤。`
    );
  }

  const commands = Array.isArray(found.manifest.commands) ? found.manifest.commands : [];
  const entry = commands.find((c) => c && c.name === command);
  if (!entry) {
    const names = commands.map((c) => c && c.name).filter(Boolean);
    fail(
      `拓展 ${id} 没有声明命令 "${command}"。\n` +
        `  它声明的是：${names.length ? names.join(' / ') : '（一个都没有）'}\n` +
        `  命令表在 ${path.join(found.dir, MANIFEST)} 的 commands 字段。`
    );
  }
  if (typeof entry.script !== 'string' || !entry.script) {
    fail(`拓展 ${id} 的命令 "${command}" 没有 script 字段 —— manifest 说得出名字却指不出脚本。`);
  }

  const scriptPath = path.join(found.dir, entry.script);
  if (!fs.existsSync(scriptPath)) {
    fail(
      `拓展 ${id} 的命令 "${command}" 指向 ${entry.script}，但它在磁盘上不存在。\n` +
        `  manifest 与目录内容对不上，属该拓展自身的问题（CI 的 extension-contract 会报它）。`
    );
  }

  // 透传 stdio：这些是交付/诊断脚本，它们的进度输出就是用户要看的东西。
  const res = cp.spawnSync(process.execPath, [scriptPath, ...rest], {
    stdio: 'inherit',
    cwd: repoRoot(),
  });
  if (res.error) {
    fail(`启动 ${entry.script} 失败：${res.error.message}`);
  }
  process.exit(res.status === null ? 1 : res.status);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { findExtension, MAX_DEPTH };
