'use strict';

/**
 * entrypoints/ — Khy 多端入口矩阵。
 *
 * 回答一个问题：**「khy 有哪些端，每个端的入口在哪，怎么起，怎么构建，现在能不能用？」**
 *
 * 在本目录出现之前，这个问题有五份互相矛盾的答案：crossLauncher.js 的
 * PLATFORM_COMMANDS（只覆盖 dev、且指向已损坏的 apps/khy-mobile）、platform/
 * khy_platform/android_build.py 的另一份路径、CLI 里 khy desktop / khy mobile
 * 两个**同名不同义**的命令、以及三处各自为政的 electron 产物线。
 *
 * 本模块是那五份答案的收敛点。它**不接管**任何端的实现——每个端仍在自己目录里
 * 构建与运行，这里只声明入口并把它翻译成一条 spawn 计划。
 *
 * 真源（数据）与实现（代码）**分居两处**，这是刻意的：
 *
 *   <root>/entries/entries.json   单一真源：端条目、平台档、状态定档
 *   <root>/entries/README.md      人读的端地图
 *   <root>/entries/launch.js      免 Python 的跨平台入口壳
 *   services/backend/src/services/entrypoints/   ← 本目录，读表的实现
 *     registry.js   加载 + 校验 + 解析（纯函数，不执行）
 *     probe.js      检活（只读，探磁盘与工具链）
 *     launcher.js   执行（attach / wait / detach 三种模式，零超时）
 *     index.js      门面（本文件）
 *
 * 表在根、代码在 L2 的理由：表要能被 Python 启动器、Node CLI、脚本、文档同时按路径读，
 * 埋进任何一层的实现目录都会让其余几个读取方要么绕路、要么违反禁止边；而代码含
 * `child_process`，必须待在 L2（[DESIGN-LAY-005] §6 第 3 条：Node 业务逻辑 → services/）。
 * 两侧的分工写在根 `entries/README.md` 里。
 *
 * 为什么不做 per-端 适配器：端的差异**全是数据**（命令、参数、cwd、工具链、平台档），
 * 没有一条端特有的分支逻辑。加一层适配器目录只会在「读表」和「启动进程」之间
 * 插一层转发，收益是零。等某个端真的长出独有逻辑（例如需要先握手再拉起），
 * 再把它单独拆成文件——那时才有东西可拆。
 *
 * 真源文档：docs/03_DESIGN_设计/[DESIGN-ARCH-117] khy-多端入口矩阵.md
 *
 * @module services/entrypoints
 */

const registry = require('./registry');
const probe = require('./probe');
const launcher = require('./launcher');

/**
 * 端矩阵总览：表级元信息 + 全部端条目。
 * @param {{ appRoot?: string, force?: boolean, kind?: string, status?: string }} [options]
 * @returns {{ meta: object, entries: object[], errors: string[], path: string }}
 */
function overview(options = {}) {
  const reg = registry.loadRegistry(options);
  return {
    meta: reg.meta,
    entries: registry.listEntries(options),
    errors: reg.errors,
    path: reg.path,
  };
}

/**
 * 单个端的完整描述（已解析路径、端口与平台档）。
 * @param {string} id
 * @param {{ appRoot?: string, platform?: string }} [options]
 * @returns {object|null}
 */
function describe(id, options = {}) {
  const entry = registry.getEntry(id, options);
  if (!entry) return null;
  return registry.describeEntry(entry, options);
}

/**
 * 探测单个端。
 * @param {string} id
 * @param {{ appRoot?: string, skipToolchain?: boolean }} [options]
 * @returns {object|null}
 */
function probeOne(id, options = {}) {
  const entry = registry.getEntry(id, options);
  if (!entry) return null;
  return probe.probeEntry(entry, options);
}

/**
 * 探测全部端（或按 kind / status 过滤后的子集）。
 * @param {{ appRoot?: string, kind?: string, status?: string, skipToolchain?: boolean }} [options]
 * @returns {object[]}
 */
function probeAll(options = {}) {
  return probe.probeAll(registry.listEntries(options), options);
}

/**
 * 启动一个端。
 * @param {string} id
 * @param {{ appRoot?: string, platform?: string, extraArgs?: string[],
 *           dryRun?: boolean }} [options]
 * @returns {Promise<object>}
 */
async function launch(id, options = {}) {
  const entry = registry.getEntry(id, options);
  if (!entry) {
    return {
      ok: false,
      mode: 'none',
      error:
        `未知的端 ${id} —— 现有端：${registry.listIds(options).join(' / ')}；` +
        '运行 `khy entry list` 查看全部端',
    };
  }
  return launcher.runEntry(entry, 'launch', options);
}

/**
 * 构建一个端。
 * @param {string} id
 * @param {{ appRoot?: string, platform?: string, extraArgs?: string[],
 *           dryRun?: boolean }} [options]
 * @returns {Promise<object>}
 */
async function build(id, options = {}) {
  const entry = registry.getEntry(id, options);
  if (!entry) {
    return {
      ok: false,
      mode: 'none',
      error:
        `未知的端 ${id} —— 现有端：${registry.listIds(options).join(' / ')}；` +
        '运行 `khy entry list` 查看全部端',
    };
  }
  return launcher.runEntry(entry, 'build', options);
}

/**
 * 按 id 取原始端条目（需要读 notes / markers 等未解析字段时用）。
 * @param {string} id
 * @param {{ appRoot?: string }} [options]
 * @returns {object|null}
 */
function raw(id, options = {}) {
  return registry.getEntry(id, options);
}

module.exports = {
  // 门面
  overview,
  describe,
  probeOne,
  probeAll,
  launch,
  build,
  raw,
  // 底层（供测试与 CLI 渲染用，语义同 registry/probe/launcher）
  registry,
  probe,
  launcher,
};
