'use strict';

/**
 * probe.js — 端检活：声明说这个端能不能用，probe 说磁盘上它到底在不在。
 *
 * 四项检查，全部只读，绝不创建目录、绝不启动端：
 *   1. source 目录在不在；                       ← 仓库级
 *   2. markers 标记文件在不在（少一个说明工程不完整）；  ← 仓库级
 *   3. toolchain 本机工具链命令在不在；            ← **本机级**，不参与定档
 *   4. deliverable 声明了 exe/apk/html 却有没有构建档； ← 仓库级
 *
 * 仓库级三维决定 `status`；本机级独立放在 `machine` 里。这条分割不是洁癖：
 * CI 机器通常没有 flutter，若把工具链算进定档，每次 probe 都会给手机端判一次
 * 假漂移，真实的不一致就再也看不见了。
 *
 * 与 entrypoints.json 的 `status` 的关系：那是**人工定档**，这里是**机器探测**。
 * 两者不一致时不覆盖数据文件——表是数据，不是代码，不该被静默改写。
 * 「磁盘比表悲观」报 `drift`（探测能确证的不一致）；「磁盘比表乐观」报 `note`
 * （定档依据多半在探测四维之外，见 statusNote）。
 *
 * @module services/entrypoints/probe
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getAppRoot } = require('../../utils/dataHome');
const { resolvePath } = require('./registry');

// 工具链探测是短 I/O 探测（路径查找，不启动被测程序），因此用固定超时是合规的：
// 工程规则 3 的合法例外清单里「≤10s 且上下文含 probe」明确豁免这一类。
// 长生命周期端（dev server / 窗口应用）绝不在本文件里启动，也就没有可被 kill 的任务。
const TOOLCHAIN_PROBE_TIMEOUT_MS = 5000;

// 需要一条构建档才能产出可分发力产物的形态。`shell` 不在此列——CLI 入口本身就是
// 仓库里的脚本，不经构建即可运行。
const KINDS_NEEDING_BUILD = new Set(['exe', 'apk', 'aab', 'html']);

const TOOLCHAIN_HINTS = {
  node: '安装 Node.js 20+ 后重试：https://nodejs.org/',
  npm: 'npm 随 Node.js 一起安装，或运行 corepack enable',
  python: '安装 Python 3.8+ 后重试：https://www.python.org/downloads/',
  flutter: '安装 Flutter SDK 并把 flutter 加入 PATH：https://docs.flutter.dev/get-started/install',
  powershell: '本端的构建脚本是 PowerShell，非 Windows 平台没有等价入口',
};

let _toolchainCache = null;

/**
 * 命令是否可解析到可执行文件。只做路径查找（where / which），不执行被测程序。
 * @param {string} command
 * @returns {boolean}
 */
function commandExists(command) {
  if (!_toolchainCache) _toolchainCache = new Map();
  if (_toolchainCache.has(command)) return _toolchainCache.get(command);

  let ok = false;
  if (command === 'node') {
    ok = true;
  } else {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(locator, [command], {
      encoding: 'utf8',
      timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    ok = res.status === 0 && String(res.stdout || '').trim().length > 0;
  }
  _toolchainCache.set(command, ok);
  return ok;
}

/**
 * 清掉工具链探测缓存（`khy entry doctor` 连跑多轮时用）。
 */
function resetToolchainCache() {
  _toolchainCache = null;
}

/**
 * 探测单个端。
 *
 * @param {object} entry — entrypoints.json 的原始条目
 * @param {{ appRoot?: string, skipToolchain?: boolean }} [options]
 * `status` 只看**仓库级**维度（源目录 / 标记文件 / 交付能力）；工具链属于**本机**
 * 维度，单独放在 `machine` 里——两者混在一起会让「这台机器没装 flutter」被误报成
 * 「这个端的声明坏了」。
 *
 * @returns {{
 *   id: string, title: string, kind: string,
 *   declaredStatus: string, status: 'ready'|'degraded'|'broken',
 *   drift: string|null, note: string|null,
 *   machine: { ok: boolean, missing: string[], detail: string },
 *   checks: Array<{ id: string, ok: boolean, machineScoped?: boolean, detail: string }>,
 *   lines: string[]
 * }}
 */
function probeEntry(entry, options = {}) {
  const appRoot = options.appRoot || getAppRoot();
  const checks = [];
  const lines = [];
  const id = entry.id;

  // ── 检查 1：源目录 ──────────────────────────────────────────────
  const sourceAbs = resolvePath(entry.source, appRoot);
  const sourceExists = Boolean(sourceAbs) && fs.existsSync(sourceAbs);
  checks.push({
    id: 'source',
    ok: sourceExists,
    detail: sourceExists
      ? `源目录存在：${entry.source}`
      : `源目录不存在：${entry.source}（端条目指向的路径已失效，请修正 entrypoints.json 或恢复该目录）`,
  });
  lines.push(
    `  探测端 ${id} (1/4)：源目录 ${entry.source} —— ${sourceExists ? '存在' : '缺失'}`
  );

  // ── 检查 2：标记文件 ────────────────────────────────────────────
  const markers = Array.isArray(entry.markers) ? entry.markers : [];
  const missingMarkers = [];
  for (const marker of markers) {
    const markerAbs = resolvePath(path.join(entry.source || '', marker), appRoot);
    if (!fs.existsSync(markerAbs)) missingMarkers.push(marker);
  }
  const markersOk = markers.length > 0 && missingMarkers.length === 0;
  checks.push({
    id: 'markers',
    ok: markersOk,
    detail:
      markers.length === 0
        ? '端条目未声明 markers，无法判断工程是否完整'
        : missingMarkers.length === 0
          ? `标记文件齐备：${markers.length}/${markers.length}`
          : `缺少标记文件 ${missingMarkers.length}/${markers.length}：${missingMarkers.join(', ')}`,
  });
  lines.push(
    `  探测端 ${id} (2/4)：标记文件 ${markers.length === 0 ? '未声明' : `${markers.length - missingMarkers.length}/${markers.length} 命中`}`
  );

  // ── 检查 3：工具链 ──────────────────────────────────────────────
  const toolchain = Array.isArray(entry.toolchain) ? entry.toolchain : [];
  const missingTools = [];
  if (!options.skipToolchain) {
    for (const tool of toolchain) {
      if (!commandExists(tool)) missingTools.push(tool);
    }
  }
  const toolchainOk = missingTools.length === 0;
  // 工具链是**本机**事实，不是**仓库**事实：一台机器没装 flutter，不代表这个端的
  // 声明坏了。因此它进 checks（给人看）但不参与 status 定档——否则 CI 机器上
  // 每次 probe 都会给手机端判一次假漂移，真实不一致反而被淹掉。
  checks.push({
    id: 'toolchain',
    ok: toolchainOk,
    machineScoped: true,
    detail:
      toolchain.length === 0
        ? '端条目未声明 toolchain（无需外部命令行工具）'
        : missingTools.length === 0
          ? `工具链齐备：${toolchain.join(', ')}`
          : `本机缺少工具链 ${missingTools.length}/${toolchain.length}：${missingTools
              .map(t => `${t}（${TOOLCHAIN_HINTS[t] || '请安装后重试'}）`)
              .join('；')}`,
  });
  lines.push(
    `  探测端 ${id} (3/4)：本机工具链 ${toolchain.length === 0 ? '无需' : `${toolchain.length - missingTools.length}/${toolchain.length} 可用`}`
  );

  // ── 检查 4：交付能力 ────────────────────────────────────────────
  // 形态是 exe / apk / html 的端必须有一条构建档，否则「端在」但「产不出可分发的东西」。
  // 这一维专门用来照出「能起 dev、却没有打包配置」那类降级。
  const artifactKind = entry.artifactKind || null;
  const needsBuild = artifactKind !== null && KINDS_NEEDING_BUILD.has(artifactKind);
  const hasBuild = Boolean(entry.build);
  const deliverableOk = !needsBuild || hasBuild;
  checks.push({
    id: 'deliverable',
    ok: deliverableOk,
    detail: !needsBuild
      ? `形态 ${artifactKind || '未声明'} 无需构建档`
      : hasBuild
        ? `形态 ${artifactKind} 有构建档，可产出可分发力产物`
        : `声明形态 ${artifactKind} 但没有构建档，产不出可分发力产物（补 build 字段，或把形态降为 planned）`,
  });
  lines.push(
    `  探测端 ${id} (4/4)：交付能力 ${!needsBuild ? `形态 ${artifactKind} 免构建` : hasBuild ? '有构建档' : '缺构建档'}`
  );

  // ── 定档（只看仓库级维度：源目录 / 标记文件 / 交付能力）────────
  let status;
  if (!sourceExists || (!markersOk && missingMarkers.length > 0)) {
    status = 'broken';
  } else if (!markersOk || !deliverableOk) {
    status = 'degraded';
  } else {
    status = 'ready';
  }

  const machine = {
    ok: toolchainOk,
    missing: missingTools,
    detail: toolchainOk
      ? toolchain.length === 0
        ? '本端无需外部命令行工具'
        : `本机工具链齐备：${toolchain.join(', ')}`
      : `本机缺少 ${missingTools.join(', ')}，本机无法构建或运行本端（仓库级声明不受影响）`,
  };

  const declared = entry.status;
  const rank = { planned: 0, broken: 1, degraded: 2, ready: 3 };
  const declaredRank = declared ? (rank[declared] ?? 2) : null;
  const probedRank = rank[status] ?? 2;

  // 只有「磁盘比表悲观」才是**漂移**——那是探测能确证的不一致（表说就绪、磁盘缺文件）。
  // 「磁盘比表乐观」不算漂移：探测只覆盖 源目录 / 标记文件 / 工具链 / 构建档 四维，
  // 而人工定档常依据探测看不到的维度（缺 electron-builder 配置、签名凭据未配、
  // 上游服务未就绪）。把这类塞进 drift 会让每次 probe 都刷一片假警报，
  // 真实漂移就被淹没了。降级为 note，附上定档依据让人自己判断。
  let drift = null;
  let note = null;
  if (declaredRank !== null && declared !== status) {
    if (probedRank < declaredRank) {
      drift = `表定档 ${declared}，磁盘探测为 ${status}：磁盘比表悲观，请修 source / markers / toolchain / build 或下调定档`;
    } else {
      note =
        `表定档 ${declared}，磁盘探测为 ${status}：探测四维（源目录/标记文件/工具链/构建档）均通过，` +
        `说明本端的定档依据在探测之外${entry.statusNote ? `（表内说明：${entry.statusNote}）` : ''}；` +
        '若该依据已消失，请上调 entrypoints.json 的 status';
    }
  }

  return {
    id,
    title: entry.title,
    kind: entry.kind,
    declaredStatus: declared,
    status,
    drift,
    note,
    machine,
    checks,
    lines,
  };
}

/**
 * 探测全部端（或过滤后的子集）。
 * @param {object[]} entries
 * @param {{ appRoot?: string, skipToolchain?: boolean }} [options]
 * @returns {Array<ReturnType<typeof probeEntry>>}
 */
function probeAll(entries, options = {}) {
  return entries.map(entry => probeEntry(entry, options));
}

module.exports = {
  TOOLCHAIN_PROBE_TIMEOUT_MS,
  TOOLCHAIN_HINTS,
  commandExists,
  resetToolchainCache,
  probeEntry,
  probeAll,
};
