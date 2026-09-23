/**
 * extensionManifest.js — manifest 读取与归一的纯函数叶（extensionRoots 的拆分件）。
 *
 * 从 extensionRoots.js 抽出「读一个拓展目录的 manifest 并归一成统一形状」这一族
 * 自包含逻辑：manifest 文件名/种类常量 + `_asArray`/`_normalize`/`readManifest`。
 * 只依赖 `fs`/`path` 与自身常量，零指向宿主扩展根的 back-edge（发现/roots/state
 * 逻辑仍归宿主，宿主单向 require 本叶的 `readManifest`）。逐字搬移，行为不变。
 *
 * @module services/extensions/extensionRoots/extensionManifest
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── manifest 名（真源；新增格式必须先改 [DESIGN-TOOL-002] 第三节）────────────
// canonical 在前、遗留在后：同一目录里多种共存时 canonical 胜，且 manifestFormat
// 字段会如实标出读到的是哪一种，供守卫与 `khy ext` 指认待迁移的拓展。
const MANIFEST_CANONICAL = 'khy.extension.json';
const MANIFEST_LEGACY_JSON = 'openclaw.plugin.json';
const MANIFEST_PKG = 'package.json';
const MANIFEST_NAMES = [MANIFEST_CANONICAL, MANIFEST_LEGACY_JSON, MANIFEST_PKG];

// 拓展种类。runtime = 参与运行时、可被激活；ide-bridge = 交付给外部 IDE 的产物
// （VSIX 等），核**不激活**它，但它仍须声明自己，否则 extensions/ 下会重新出现
// 「说不清是什么」的目录——那正是本契约要消灭的东西；asset = 纯资源包。
//
// toolchain = 交付 / 诊断 / 构建脚本。它与 runtime 的区别是**执行位置**：核不 require
// 它的入口，而是照 manifest 的 commands[].script 起一个子进程（scripts/lib/ext-run.js）。
// 因此它不受惰性激活那套约束，也拿不到 ctx —— 它只是一堆能被按名字叫到的脚本。
// 单列一类而不是塞进 asset：asset 是惰性的资源，没人「运行」它；这些是要运行的。
const KINDS = new Set(['runtime', 'ide-bridge', 'asset', 'toolchain']);

function _asArray(v) {
  return Array.isArray(v) ? v : [];
}

// namespace 缺省取目录名：去重键与显示名都以**目录**为准（与既有 extensionManager 行为
// 一致，也是「删目录即消失」能成立的前提——键不能藏在文件内容里）。
function _normalize(body, { dir, id, manifestFile, format }) {
  const namespace = typeof body.namespace === 'string' && body.namespace ? body.namespace : id;
  const engines = body.engines && typeof body.engines === 'object' ? body.engines : {};
  // 入口键两套并存（plugin-loader 用 main，extensionManager 用 entry）→ 归一为 main，
  // 同时保留 entry 别名，旧调用点无需改字段名即可读到值。
  const main =
    typeof body.main === 'string' ? body.main : typeof body.entry === 'string' ? body.entry : undefined;
  // kind 缺省 runtime：遗留 manifest 里没有这个字段，而它们无一例外都是运行时拓展，
  // 缺省值因此不改变任何既有拓展的行为。
  const kind = KINDS.has(body.kind) ? body.kind : 'runtime';
  return {
    id,
    namespace,
    kind,
    name: typeof body.name === 'string' && body.name ? body.name : id,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    version: typeof body.version === 'string' ? body.version : '0.0.0',
    description: typeof body.description === 'string' ? body.description : '',
    engines: { khy: typeof engines.khy === 'string' ? engines.khy : undefined },
    main,
    entry: main,
    capabilities: _asArray(body.capabilities),
    // provides = 该拓展对**核**声明的服务名（见 [DESIGN-TOOL-002] 第 3.4 节）。
    // 与 capabilities 的区别是方向：capabilities 说「我往注册表里贡献什么」，
    // provides 说「核可以按什么名字找到我」——后者是核不点名具体拓展的前提。
    provides: _asArray(body.provides).filter((x) => typeof x === 'string' && x),
    tools: _asArray(body.tools),
    commands: _asArray(body.commands),
    skills: _asArray(body.skills),
    mcp: body.mcp && typeof body.mcp === 'object' ? body.mcp : null,
    permissions: body.permissions && typeof body.permissions === 'object' ? body.permissions : {},
    dir,
    manifestFile,
    manifestFormat: format,
    isLegacyFormat: format !== MANIFEST_CANONICAL,
  };
}

/**
 * 读一个拓展目录的 manifest 并归一成统一形状。
 *
 * 三种格式按 MANIFEST_NAMES 顺序试；`package.json` 只在含 `khy` 字段时才算 manifest，
 * 否则一个普通 npm 包会被误认成拓展。
 *
 * @param {string} dir - 拓展目录绝对路径
 * @returns {object|null} 归一后的 manifest，或 null（无 manifest / 坏 manifest）
 */
function readManifest(dir) {
  if (!dir || typeof dir !== 'string') {
    return null;
  }
  const id = path.basename(dir);

  for (const fileName of MANIFEST_NAMES) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, fileName), 'utf-8');
    } catch {
      continue; // 该格式不存在 → 试下一种
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 坏 JSON → 当作没有这一格式（不静默接受半个 manifest）
    }
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }

    let body = parsed;
    let format = fileName;
    if (fileName === MANIFEST_PKG) {
      if (!parsed.khy || typeof parsed.khy !== 'object') {
        continue; // 普通 npm 包，不是拓展
      }
      body = { name: parsed.name, version: parsed.version, ...parsed.khy };
      format = 'package.json#khy';
    }

    return _normalize(body, { dir, id, manifestFile: fileName, format });
  }
  return null;
}

module.exports = {
  readManifest,
  MANIFEST_CANONICAL,
  MANIFEST_LEGACY_JSON,
  MANIFEST_NAMES,
  KINDS,
};
