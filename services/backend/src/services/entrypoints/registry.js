'use strict';

/**
 * registry.js — 端矩阵的加载、校验与解析。
 *
 * 单一真源是**仓库根**的 `entries/entries.json`（数据），本文件只做三件事：
 *   1. 读它，缺字段/重复 id 时报出来而不是抛出去（fail-soft）；
 *   2. 解析占位符：`<appRoot>` → 仓库/安装根，`ports[].ref` → serviceDefaults 常量；
 *   3. 按当前平台挑出 launch / build 该用哪一档。
 *
 * 不在这里做的事（刻意）：
 *   - **不解析产物路径**。产物坐标的真源是 docs/10_规范/registry/BUILD-OUTPUTS.json，
 *     端条目只存它的 id 指针。L2 读 docs/ 在本仓无先例，且复制一份 path 就是
 *     第二份真源——那正是 LAYOUT-005 要消灭的东西。
 *   - **不执行任何东西**。执行在 launcher.js，检活在 probe.js，本文件是纯函数。
 *
 * @module services/entrypoints/registry
 */

const fs = require('fs');
const path = require('path');

const { getAppRoot } = require('../../utils/dataHome');
const serviceDefaults = require('../../constants/serviceDefaults');

// 相对 <appRoot> 的真源路径。
//
// 表放在**仓库根** `entries/`：它是多端入口的登记处，应当与端本身同层可见，
// 而不该埋在某个实现目录里。这里按 <appRoot> 解析路径去读它——这是**按路径读一个
// 数据文件**，不是 import 源码，因此不构成 [DESIGN-LAY-005] §2 的禁止边
// （`cross-layer-require` 盯的是 require/import 深层相对路径，不是数据文件读取）。
// 与 `extensionRoots.js` 读各拓展根的 `khy.extension.json` 是同一类操作。
// 根 `entries/` 已在 [DESIGN-LAY-005] §1.2 横切层登记，且该层「不参与依赖判定」。
const ENTRYPOINTS_REL = path.join('entries', 'entries.json');

// 产物坐标的真源：docs/10_规范/registry/BUILD-OUTPUTS.json（LAYOUT-005 / [DESIGN-LAY-004]）。
//
// **这是一处刻意的决策反转**（2026-09-17）。本模块初版写的是「运行时代码不读那张表，
// 指针只留给人和 CLI 输出」，理由是 L2 读 docs/ 在本仓无先例。那个理由站得住，
// 但它买到的东西是零，代价是**端矩阵答不出用户真正要问的问题**：
// 「exe / apk / html 到底在哪、产出来没有」。实测反馈证明后者才是需求。
//
// 反转后的取舍：读**已登记的真源表**，而不是把产物路径抄进 entries.json。
// 抄一份 path 就是第二份真源，而那正是 LAYOUT-005 要消灭的东西；
// 读登记表则天然跟着登记表走——登记表改了坐标，端矩阵立刻跟着改。
//
// 仍是按路径读数据文件（非 require），fail-soft：读不到就降级为「只显示登记 id」，
// 不影响 list / probe / launch。
const BUILD_OUTPUTS_REL = path.join('docs', '10_规范', 'registry', 'BUILD-OUTPUTS.json');

// 计划里代表仓库根的占位符。数据文件里只写它，不写绝对路径（RUNTIME-001）。
const ROOT_TOKEN = '<appRoot>';

const REQUIRED_ENTRY_FIELDS = ['id', 'kind', 'title', 'source', 'status'];
const PLAN_FIELDS = ['launch', 'build'];
const DEFAULT_PLAN_KEY = 'default';

let _cache = null;
let _cacheRoot = null;
let _buildOutputsCache = null;
let _buildOutputsRoot = null;

/**
 * 判断一个路径是否「真的有东西」。
 *
 * 目录存在但空着不算有——构建到一半失败、或 clean 之后留下的空壳目录，
 * 报「已产出」会把人骗到，而「产物在不在」这个问题答错的代价是白跑一趟构建。
 *
 * @param {string} abs
 * @returns {boolean}
 */
function pathHasContent(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) return stat.size > 0;
    return fs.readdirSync(abs).length > 0;
  } catch {
    return false;
  }
}

/**
 * 读产物登记表（LAYOUT-005 的真源），建 id → 条目 的索引。
 * 读不到时返回空 Map 并记原因——调用方降级，不抛。
 *
 * @param {{ appRoot?: string, force?: boolean }} [options]
 * @returns {{ index: Map<string, object>, errors: string[], path: string }}
 */
function loadBuildOutputs(options = {}) {
  const appRoot = options.appRoot || getAppRoot();
  if (_buildOutputsCache && _buildOutputsRoot === appRoot && !options.force) {
    return _buildOutputsCache;
  }

  const file = path.join(appRoot, BUILD_OUTPUTS_REL);
  const result = { index: new Map(), errors: [], path: file };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const output of Array.isArray(raw.outputs) ? raw.outputs : []) {
      if (output && typeof output.id === 'string') result.index.set(output.id, output);
    }
  } catch (err) {
    result.errors.push(
      `产物登记表读取失败：${file} —— ${err.message}；` +
        '端矩阵会降级为只显示登记 id，产物坐标请直接查该文件'
    );
  }

  _buildOutputsCache = result;
  _buildOutputsRoot = appRoot;
  return result;
}

/**
 * 把一个端条目解析到它的产物坐标上。
 *
 * 登记表里一条产物有两个位置：`path` 是**目标**（`entries/` 产物根之下），
 * `legacyPath` 是**尚未迁完的当前位置**，`status: migrating` 表示两者都允许存在。
 * 因此两个都探，谁真有东西就报谁——报目标位置而磁盘上还没迁过去，等于骗人。
 *
 * @param {object} entry
 * @param {{ appRoot?: string }} [options]
 * @returns {{
 *   registered: boolean, id: string|null, reason: string|null,
 *   status: string|null, rebuild: string|null,
 *   exists: boolean, presentAt: string|null,
 *   candidates: Array<{ rel: string, abs: string, exists: boolean }>
 * }}
 */
function resolveArtifact(entry, options = {}) {
  const appRoot = options.appRoot || getAppRoot();
  const id = entry && entry.artifactOutput ? entry.artifactOutput : null;

  const empty = {
    registered: false,
    id,
    reason: null,
    status: null,
    rebuild: null,
    exists: false,
    presentAt: null,
    candidates: [],
  };

  if (!id) {
    return { ...empty, reason: '端条目未声明 artifactOutput（见 entries.json）' };
  }

  const { index, errors } = loadBuildOutputs({ appRoot: options.appRoot });
  if (errors.length > 0 && index.size === 0) {
    return { ...empty, reason: errors[0] };
  }

  const record = index.get(id);
  if (!record) {
    return {
      ...empty,
      reason:
        `产物登记表里没有 id 为 "${id}" 的条目 —— ` +
        '按 LAYOUT-005，每个构建产物都要登记 path + rebuild + inBuildAll；' +
        '请在 docs/10_规范/registry/BUILD-OUTPUTS.json 补登记，或修正 entries.json 的 artifactOutput',
    };
  }

  // 目标优先、当前位置兜底；两者都没有内容时按目标位置报（那是它该去的地方）。
  const rels = [record.path, record.legacyPath].filter(
    rel => typeof rel === 'string' && rel.length > 0
  );
  const candidates = rels.map(rel => {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(appRoot, rel);
    return { rel, abs, exists: pathHasContent(abs) };
  });
  const present = candidates.find(c => c.exists) || null;

  return {
    registered: true,
    id,
    reason: null,
    status: record.status || null,
    rebuild: record.rebuild || null,
    exists: Boolean(present),
    presentAt: present ? present.rel : null,
    candidates,
  };
}

/**
 * 端的规范化平台键。只区分本仓实际声明过的三档 + default；
 * 其它平台（freebsd 等）落到 default，落不到就诚实报「无声明」。
 * @param {string} [platform]
 * @returns {string}
 */
function normalizePlatform(platform) {
  const p = platform || process.platform;
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  return DEFAULT_PLAN_KEY;
}

/**
 * 把 `<appRoot>` 占位符与仓库相对路径解析成绝对路径。
 * @param {string|null|undefined} rel
 * @param {string} appRoot
 * @returns {string|null}
 */
function resolvePath(rel, appRoot) {
  if (!rel || typeof rel !== 'string') return null;
  if (rel === ROOT_TOKEN) return appRoot;
  if (rel.includes(ROOT_TOKEN)) return path.resolve(rel.replace(ROOT_TOKEN, appRoot));
  if (path.isAbsolute(rel)) return path.resolve(rel);
  return path.resolve(appRoot, rel);
}

/**
 * 把 ports[].ref 解析成实际端口号。
 *
 * 端口真源是 constants/serviceDefaults.js —— 本表**不允许**出现端口字面量
 * （工程规则 1 / RUNTIME-001）。ref 拼错或常量未登记时返回 null，
 * 让调用方显示「未登记」而不是一个猜出来的数字。
 *
 * @param {string} ref
 * @returns {{ ref: string, port: number|null, reason?: string }}
 */
function resolvePort(ref) {
  if (!ref || typeof ref !== 'string') {
    return { ref: String(ref), port: null, reason: '端口引用为空' };
  }
  const value = serviceDefaults[ref];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ref, port: value };
  }
  return {
    ref,
    port: null,
    reason:
      `serviceDefaults 未导出名为 ${ref} 的数值端口，` +
      '请先在 services/backend/src/constants/serviceDefaults.js 登记该常量',
  };
}

/**
 * 挑出某个字段（launch / build）在当前平台应使用的那一档计划。
 *
 * @param {object} entry
 * @param {'launch'|'build'} field
 * @param {string} platform
 * @returns {object|null} 原始 step（未解析路径），无声明时返回 null
 */
function pickStep(entry, field, platform) {
  const plan = entry?.[field];
  if (!plan || typeof plan !== 'object') return null;
  const key = normalizePlatform(platform);
  if (plan[key] && typeof plan[key] === 'object') return plan[key];
  if (plan[DEFAULT_PLAN_KEY] && typeof plan[DEFAULT_PLAN_KEY] === 'object') {
    return plan[DEFAULT_PLAN_KEY];
  }
  return null;
}

/**
 * 把一条原始 step 解析成可直接 spawn 的计划。
 *
 * cwd 缺省为端条目的 source；不做任何超时——长生命周期端（dev server、窗口应用）
 * 由调用方以 detach 模式启动，绝不在固定时长后 kill（工程规则 3 / RUNTIME-003）。
 *
 * @param {object} entry
 * @param {'launch'|'build'} field
 * @param {{ appRoot?: string, platform?: string, extraArgs?: string[] }} [options]
 * @returns {{ id: string, field: string, command: string, args: string[],
 *             cwd: string|null, mode: string, shell: boolean,
 *             platformKey: string } | null}
 */
function resolvePlan(entry, field, options = {}) {
  if (!entry) return null;
  if (!PLAN_FIELDS.includes(field)) {
    throw new Error(`未知的计划字段 ${field}：只支持 ${PLAN_FIELDS.join(' / ')}`);
  }
  const appRoot = options.appRoot || getAppRoot();
  const platform = normalizePlatform(options.platform);
  const step = pickStep(entry, field, platform);
  if (!step) return null;
  if (typeof step.command !== 'string' || !step.command) return null;

  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  return {
    id: entry.id,
    field,
    command: step.command,
    args: [...(Array.isArray(step.args) ? step.args : []), ...extraArgs],
    cwd: resolvePath(step.cwd || entry.source, appRoot),
    mode: typeof step.mode === 'string' ? step.mode : 'detach',
    shell: Boolean(step.shell),
    platformKey: platform,
  };
}

/**
 * 校验单个端条目。返回错误字符串数组，空数组表示通过。
 * @param {object} entry
 * @param {Set<string>} seenIds
 * @param {object} registry
 * @returns {string[]}
 */
function validateEntry(entry, seenIds, registry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return ['条目不是对象'];
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (!id) {
    return ['缺少 id（或 id 不是非空字符串）'];
  }
  for (const field of REQUIRED_ENTRY_FIELDS) {
    const value = entry[field];
    if (value === undefined || value === null || value === '') {
      errors.push(`端 ${id} 缺少必填字段 ${field}`);
    }
  }
  if (seenIds.has(id)) {
    errors.push(`端 id 重复：${id}（后一条被忽略，请合并或改名）`);
  }
  if (entry.kind && registry?.kinds && !registry.kinds[entry.kind]) {
    errors.push(
      `端 ${id} 的 kind=${entry.kind} 未在 kinds 里登记，` +
        `请在 entrypoints.json 的 kinds 补一行（现有：${Object.keys(registry.kinds).join(' / ')}）`
    );
  }
  if (entry.status && registry?.statuses && !registry.statuses[entry.status]) {
    errors.push(
      `端 ${id} 的 status=${entry.status} 未在 statuses 里登记，` +
        `请在 entrypoints.json 的 statuses 补一行（现有：${Object.keys(registry.statuses).join(' / ')}）`
    );
  }
  for (const field of PLAN_FIELDS) {
    const plan = entry[field];
    if (plan === null || plan === undefined) continue;
    if (typeof plan !== 'object') {
      errors.push(`端 ${id} 的 ${field} 必须是对象或 null`);
      continue;
    }
    const keys = Object.keys(plan);
    const hasExecutable = keys.some(k =>
      plan[k] && typeof plan[k] === 'object' && typeof plan[k].command === 'string'
    );
    if (!hasExecutable) {
      errors.push(
        `端 ${id} 的 ${field} 里没有任何带 command 的平台档，` +
          `请写 { "${DEFAULT_PLAN_KEY}": { "command": …, "args": […] } }`
      );
    }
  }
  const ports = entry.ports;
  if (ports !== undefined && !Array.isArray(ports)) {
    errors.push(`端 ${id} 的 ports 必须是数组`);
  } else if (Array.isArray(ports)) {
    for (const p of ports) {
      if (!p || typeof p.ref !== 'string' || !p.ref) {
        errors.push(`端 ${id} 的 ports 项缺少 ref（端口必须写 serviceDefaults 的导出名，不得写字面量）`);
      }
    }
  }
  return errors;
}

/**
 * 读端矩阵。结果按 appRoot 缓存一次；文件缺失或 JSON 坏掉时返回空表 + errors，
 * 不抛异常——一个坏掉的数据文件不该让整个 CLI 起不来。
 *
 * @param {{ appRoot?: string, force?: boolean }} [options]
 * @returns {{ meta: object, kinds: object, statuses: object, modes: object,
 *             entries: object[], errors: string[], path: string, exists: boolean }}
 */
function loadRegistry(options = {}) {
  const appRoot = options.appRoot || getAppRoot();
  if (_cache && _cacheRoot === appRoot && !options.force) {
    return _cache;
  }

  const file = path.join(appRoot, ENTRYPOINTS_REL);
  const empty = {
    meta: {},
    kinds: {},
    statuses: {},
    modes: {},
    entries: [],
    errors: [],
    path: file,
    exists: false,
  };

  if (!fs.existsSync(file)) {
    empty.errors.push(
      `端矩阵文件不存在：${file} —— 请确认安装完整，或设置 KHY_OS_ROOT 指向 Khy-OS 根目录`
    );
    _cache = empty;
    _cacheRoot = appRoot;
    return _cache;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    empty.exists = true;
    empty.errors.push(
      `端矩阵 JSON 解析失败：${err.message} —— 修复 ${file} 的语法后重试`
    );
    _cache = empty;
    _cacheRoot = appRoot;
    return _cache;
  }

  const registry = {
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
    kinds: raw.kinds && typeof raw.kinds === 'object' ? raw.kinds : {},
    statuses: raw.statuses && typeof raw.statuses === 'object' ? raw.statuses : {},
    modes: raw.modes && typeof raw.modes === 'object' ? raw.modes : {},
    entries: [],
    errors: [],
    path: file,
    exists: true,
  };

  const seen = new Set();
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  if (!Array.isArray(raw.entries)) {
    registry.errors.push('端矩阵缺少 entries 数组 —— 请补上，哪怕是空数组');
  }
  for (const entry of list) {
    const errors = validateEntry(entry, seen, registry);
    if (errors.length > 0) {
      registry.errors.push(...errors);
      const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id || seen.has(id)) continue;
    }
    if (entry && typeof entry.id === 'string' && entry.id.trim()) {
      seen.add(entry.id.trim());
    }
    registry.entries.push(entry);
  }

  _cache = registry;
  _cacheRoot = appRoot;
  return registry;
}

/**
 * 清掉缓存（测试与长驻进程改表后使用）。
 */
function resetCache() {
  _cache = null;
  _cacheRoot = null;
  _buildOutputsCache = null;
  _buildOutputsRoot = null;
}

/**
 * 列出全部端条目。
 * @param {{ appRoot?: string, kind?: string, status?: string }} [options]
 * @returns {object[]}
 */
function listEntries(options = {}) {
  const registry = loadRegistry(options);
  return registry.entries.filter(entry => {
    if (options.kind && entry.kind !== options.kind) return false;
    if (options.status && entry.status !== options.status) return false;
    return true;
  });
}

/**
 * 按 id 取一个端条目（大小写不敏感、允许首尾空格）。
 * @param {string} id
 * @param {{ appRoot?: string }} [options]
 * @returns {object|null}
 */
function getEntry(id, options = {}) {
  if (!id || typeof id !== 'string') return null;
  const wanted = id.trim().toLowerCase();
  const found = loadRegistry(options).entries.find(
    entry => String(entry.id).toLowerCase() === wanted
  );
  return found || null;
}

/**
 * 全部端 id，用于「你输入的这个端不存在」类报错里的候选提示。
 * @param {{ appRoot?: string }} [options]
 * @returns {string[]}
 */
function listIds(options = {}) {
  return loadRegistry(options).entries.map(entry => entry.id);
}

/**
 * 把一个端条目展开成「人看的摘要 + 机器要的解析结果」。
 * @param {object} entry
 * @param {{ appRoot?: string, platform?: string }} [options]
 * @returns {object}
 */
function describeEntry(entry, options = {}) {
  const appRoot = options.appRoot || getAppRoot();
  const platform = normalizePlatform(options.platform);
  const launch = resolvePlan(entry, 'launch', { appRoot, platform: options.platform });
  const build = resolvePlan(entry, 'build', { appRoot, platform: options.platform });
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    artifactKind: entry.artifactKind || null,
    delivery: entry.delivery || null,
    status: entry.status,
    statusNote: entry.statusNote || null,
    source: resolvePath(entry.source, appRoot),
    sourceRel: entry.source,
    launch,
    build,
    buildUnavailableReason:
      !build && entry.build
        ? `本端未声明 ${platform} 平台的构建档`
        : !build
          ? '本端未声明构建方式'
          : null,
    launchUnavailableReason:
      !launch && entry.launch
        ? `本端未声明 ${platform} 平台的启动档`
        : !launch
          ? '本端未声明启动方式'
          : null,
    ports: Array.isArray(entry.ports) ? entry.ports.map(p => resolvePort(p.ref)) : [],
    artifactOutput: entry.artifactOutput || null,
    artifact: resolveArtifact(entry, { appRoot }),
    // 仓库内的入口文件（shell 类端才有）：这些是「日常进入方式」，
    // 与 artifactOutput 那条「打包形态」是两件事——`khy.bat` 存在不等于
    // pip wheel 已构建，反过来也一样。分开报，避免把两者混成一个「在/不在」。
    entryFiles: (Array.isArray(entry.entryFiles) ? entry.entryFiles : []).map(rel => {
      const abs = path.isAbsolute(rel) ? rel : path.resolve(appRoot, rel);
      return { rel, abs, exists: fs.existsSync(abs) };
    }),
    notes: Array.isArray(entry.notes) ? entry.notes : [],
  };
}

module.exports = {
  ENTRYPOINTS_REL,
  BUILD_OUTPUTS_REL,
  pathHasContent,
  loadBuildOutputs,
  resolveArtifact,
  ROOT_TOKEN,
  DEFAULT_PLAN_KEY,
  normalizePlatform,
  resolvePath,
  resolvePort,
  resolvePlan,
  loadRegistry,
  resetCache,
  listEntries,
  listIds,
  getEntry,
  describeEntry,
};
