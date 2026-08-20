/**
 * extensionRoots.js — 拓展根与 manifest 的**单一真源**（[DESIGN-ARCH-069] 的落地件）。
 *
 * 背景：本仓此前有三套互不认识的拓展机制，各自硬编码自己的根目录与 manifest 名：
 *   - plugin-loader/index.js            `package.json#khy`     + `<dataHome>/plugins`
 *   - services/extensions/extensionManager  `openclaw.plugin.json` + `<appHome>/extensions`
 *   - services/plugins/pluginContribResolver  复制了后者的三个常量（注释里写着「与
 *     extensionManager 按构造保持同步」——即靠人记住，不靠机器）。
 * 后果是「装在哪、叫什么、谁能看见」三个问题各有两个答案，且仓库自己的 `extensions/`
 * 目录**没有任何加载器扫描它**。本模块把这些常量收敛到一处，所有加载器改从这里取。
 *
 * 核心语义：**文件系统就是注册表**。
 *   - 目录在 + manifest 可解析 → 该拓展存在（不需要任何 state 条目为它背书）。
 *   - 目录不在 → 该拓展不存在（state 里的残留条目**不得**让它复活，见 findOrphanState）。
 *   - 只有 `state[id].enabled === false` 这一种显式禁用能压住一个在位的目录。
 *
 * 只读探测器：本模块只做 readdir / readFile / JSON.parse，绝不写盘、绝不 require 拓展
 * 入口（惰性激活是 pluginContribResolver 的职责）。任何读失败或坏 JSON → 跳过该项继续，
 * 绝不抛给调用方。
 *
 * 门控 KHY_EXTENSION_REPO_ROOT（default-on）只管**仓库根**这一路新增发现；关掉它 →
 * 回退到本模块引入前的根集合（用户目录两处 + 遗留 plugins）。
 *
 * @module services/extensions/extensionRoots
 * @pattern Facade, Iterator
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── manifest 名（真源；新增格式必须先改 [DESIGN-ARCH-069] 第三节）────────────
// canonical 在前、遗留在后：同一目录里多种共存时 canonical 胜，且 manifestFormat
// 字段会如实标出读到的是哪一种，供守卫与 `khy ext` 指认待迁移的拓展。
const MANIFEST_CANONICAL = 'khy.extension.json';
const MANIFEST_LEGACY_JSON = 'openclaw.plugin.json';
const MANIFEST_PKG = 'package.json';
const MANIFEST_NAMES = [MANIFEST_CANONICAL, MANIFEST_LEGACY_JSON, MANIFEST_PKG];

// state 文件沿用 extensionManager 既有路径与语义（不迁移、不改名）。
const STATE_FILE_NAME = 'extensions_state.json';

// 拓展种类。runtime = 参与运行时、可被激活；ide-bridge = 交付给外部 IDE 的产物
// （VSIX 等），核**不激活**它，但它仍须声明自己，否则 extensions/ 下会重新出现
// 「说不清是什么」的目录——那正是本契约要消灭的东西；asset = 纯资源包。
//
// toolchain = 交付 / 诊断 / 构建脚本。它与 runtime 的区别是**执行位置**：核不 require
// 它的入口，而是照 manifest 的 commands[].script 起一个子进程（scripts/lib/ext-run.js）。
// 因此它不受惰性激活那套约束，也拿不到 ctx —— 它只是一堆能被按名字叫到的脚本。
// 单列一类而不是塞进 asset：asset 是惰性的资源，没人「运行」它；这些是要运行的。
const KINDS = new Set(['runtime', 'ide-bridge', 'asset', 'toolchain']);

const GATE_REPO_ROOT = 'KHY_EXTENSION_REPO_ROOT';

function _flagOn(name, env) {
  try {
    return require('../flagRegistry').isFlagEnabled(name, env || process.env);
  } catch {
    return true; // 注册表不可用 → 保持 default-on 语义
  }
}

function _appHome() {
  try {
    return require('../../utils/dataHome').getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}

function _dataHome() {
  try {
    return require('../../utils/dataHome').getDataHome();
  } catch {
    return path.join(os.homedir(), '.khy');
  }
}

/**
 * 仓库 / 安装根下的内置拓展目录。dev 与 pip、npm bundled 布局里 `extensions/` 都与
 * `services/` 同级，getAppRoot() 已把这条（含 KHY_OS_ROOT 覆盖）算好，不再自己数 `..`。
 * @returns {string|null} 绝对路径，解析失败则 null
 */
function repoExtensionsDir() {
  try {
    const { getAppRoot } = require('../../utils/dataHome');
    return path.join(getAppRoot(), 'extensions');
  } catch {
    return null;
  }
}

/**
 * 用户安装拓展的目录（`extensionManager` 的**写入**目标）。
 *
 * 与 repoExtensionsDir() 的区别是方向：仓库根**只读**（随包分发，装包时就定了），
 * 用户目录是唯一可写的根。`khy extension install` 只往这里写；发现路径两者都看。
 * @returns {string} 绝对路径（可能尚不存在——安装器负责建）
 */
function userExtensionsDir() {
  return path.join(_appHome(), 'extensions');
}

/**
 * 全部拓展根，**按优先级降序**。同名（= 同目录名）拓展先出现者胜。
 *
 * 1. KHY_EXTENSION_PATH   path-list 覆盖（开发 / 测试用，最高）
 * 2. <appRoot>/extensions 仓库内置拓展，随包分发（门控 KHY_EXTENSION_REPO_ROOT）
 * 3. <appHome>/extensions 用户安装的（extensionManager 的家）
 * 4. <appHome>/plugins    遗留 plugin-loader 目录
 * 5. <dataHome>/plugins   遗留 plugin-loader 目录（appHome ≠ dataHome 时才多出一条）
 *
 * 仓库根优先于用户目录：内置拓展是平台承诺的一部分，用户目录里的同名目录不得静默顶替
 * 它——要顶替就改名，于是冲突永远是可见的，而不是取决于扫描顺序。
 *
 * @param {object} [opts] - { env } 便于单测注入
 * @returns {Array<{dir: string, source: string, builtin: boolean}>} 只含**磁盘上存在**的根
 */
function listRoots(opts = {}) {
  const env = opts.env || process.env;
  const roots = [];
  const seen = new Set();

  const push = (dir, source, builtin) => {
    if (!dir) {
      return;
    }
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        return;
      }
    } catch {
      return; // 不存在的根直接不进列表——调用方无需再判存在性
    }
    roots.push({ dir: resolved, source, builtin: !!builtin });
  };

  const override = env && env.KHY_EXTENSION_PATH;
  if (override && String(override).trim()) {
    for (const part of String(override).split(path.delimiter)) {
      if (part.trim()) {
        push(part.trim(), 'override', false);
      }
    }
  }

  if (_flagOn(GATE_REPO_ROOT, env)) {
    push(repoExtensionsDir(), 'builtin', true);
  }

  push(userExtensionsDir(), 'user', false);
  push(path.join(_appHome(), 'plugins'), 'legacy-plugins', false);
  push(path.join(_dataHome(), 'plugins'), 'legacy-plugins', false);

  return roots;
}

// ── 分类目录（[DESIGN-ARCH-069] §2.3）─────────────────────────────────────
// 一个根下的直接子目录若**自己没有 manifest**、却含有带 manifest 的子目录，它就是
// **分类目录**：只负责归类，本身不是拓展。发现因此下探恰好一层，不再往下。
//
// 为什么判据是「有没有 manifest」而不是一份分类名白名单：白名单要么写在加载器里
// （于是「文件系统就是注册表」变成「加载器里那张表才是注册表」），要么写进一个新的
// extensions/ 根 manifest（于是 extensions/ 自己成了要维护的注册表，拖入目录不再够用）。
// 用「有无 manifest」则两者都不需要——分类目录天然是空壳。仓库自己那几个分类名的收敛
// 由 CI（check-repo-layout 规则 8）管：那是仓库卫生，不是加载机制。
//
// 为什么只下探一层：`id` 必须是**叶子目录名**（§3.3），它同时是 state 键、冲突键与
// 孤儿检测键。允许任意深度后「目录名」不再唯一指代一个东西，`a/khy-x` 与 `khy-x`
// 的关系就变成需要裁决的新问题。一层足够分类，两层开始需要规则。
const MAX_DEPTH = 2;

/**
 * 列一个目录下可能承载拓展的子目录名，**已排序**。
 *
 * discover 与 findOrphanState 共用它：两者若在「扫哪些目录」上有一丝分歧，就会出现
 * 「在位的拓展被判成残留」这种最坏的不一致（清理动作会照着残留名单动手）。
 *
 * @param {string} dir - 绝对路径
 * @returns {string[]} 子目录名（不含 . 开头与 node_modules），字典序
 */
function _listDirNames(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  // 排序：同一根内的发现顺序不依赖文件系统返回序，冲突裁决因此确定可复现。
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => !n.startsWith('.') && n !== 'node_modules')
    .sort();
}

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
    // provides = 该拓展对**核**声明的服务名（见 [DESIGN-ARCH-069] 第 3.4 节）。
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

// ── state（只读；写盘仍归 extensionManager）────────────────────────────────

function stateFilePath() {
  return path.join(_appHome(), STATE_FILE_NAME);
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // 缺失 / 坏文件 = 无显式禁用 = 全部在位的拓展都算启用
  }
}

/**
 * 显式禁用检查。**缺条目 = 启用**——这是 drop-in 的前提：拖进目录不必先登记。
 * @param {string} id - 拓展 id（目录名）
 * @param {object} [state] - 复用已读的 state，省一次读盘
 * @returns {boolean}
 */
function isEnabled(id, state) {
  const s = state || readState();
  return s[id] ? s[id].enabled !== false : true;
}

/**
 * 扫全部根，返回在位且 manifest 可解析的拓展。
 *
 * 两层布局（§2.3）：`<root>/<id>/` 与 `<root>/<分类>/<id>/` 都被发现，`id` 一律是
 * **叶子目录名**——分类只体现在磁盘布局与 `category` 字段上，不进 id。于是把一个拓展
 * 移进分类目录不改变它的 state 键、冲突键与孤儿判定，迁移不会顺手改掉它的身份。
 *
 * 自带 manifest 的目录优先按拓展处理，**不再**下探它的子目录：显式自我声明胜过按
 * 结构推断，否则一个拓展在自己目录里放了 vendor 子拓展就会被当成分类目录整块散开。
 *
 * @param {object} [opts] - { env, includeDisabled }
 * @returns {Array<object>} 归一 manifest 附加 { category, root, source, builtin, enabled }
 */
function discover(opts = {}) {
  const state = readState();
  const found = [];
  const seenIds = new Set();

  for (const root of listRoots(opts)) {
    /** 收下一个候选目录；返回它是否是拓展（用于判定父目录该不该当分类目录下探）。 */
    const take = (dir, category) => {
      const manifest = readManifest(dir);
      if (!manifest) {
        return false;
      }
      if (seenIds.has(manifest.id)) {
        return true; // 更高优先级的根 / 更前的分类已提供同名拓展
      }
      seenIds.add(manifest.id);
      const enabled = isEnabled(manifest.id, state);
      if (!enabled && !opts.includeDisabled) {
        return true;
      }
      found.push({
        ...manifest,
        category,
        root: root.dir,
        source: root.source,
        builtin: root.builtin,
        enabled,
      });
      return true;
    };

    for (const name of _listDirNames(root.dir)) {
      const dir = path.join(root.dir, name);
      if (take(dir, null)) {
        continue; // 自己就是拓展 → 不下探
      }
      // 没 manifest → 可能是分类目录。空目录 / 杂物目录在这里自然什么也产不出。
      for (const child of _listDirNames(dir)) {
        take(path.join(dir, child), name);
      }
    }
  }
  return found;
}

/**
 * 按**服务名**找提供者，而不是按拓展 id 找目录。
 *
 * 这是 [DESIGN-ARCH-069] §1.3 第四条「核里不允许出现任何拓展 id 的硬编码分支」的落地
 * 手段：核说「我要一个 markdown-workbench」，不说「我要 khy-markdown」。于是拓展可以
 * 改名、可以被第三方实现替换、可以装在任何一个根下，核一行都不用改。
 *
 * 冲突策略与 §2.1 同构：多个拓展声明同一服务时，**根优先级高者胜**（discover 已按根序
 * 返回），不看谁的版本新——版本裁决会让「装了什么」影响「用哪个」，那正是要避免的。
 *
 * @param {string} service - 服务名，如 'markdown-workbench'
 * @param {object} [opts] - { env, probe } probe 为相对拓展目录的入口探针文件名：
 *   声明了服务却没带着入口的目录不算数，否则一个同名空目录就能骗过解析。
 * @returns {object|null} 归一 manifest（含 dir / root / source），无提供者则 null
 */
function findProvider(service, opts = {}) {
  if (!service || typeof service !== 'string') {
    return null;
  }
  let found;
  try {
    found = discover(opts);
  } catch {
    return null; // 只读探测器不抛给调用方（模块头约定）
  }
  for (const ext of found) {
    if (!ext.provides.includes(service)) {
      continue;
    }
    if (opts.probe) {
      try {
        if (!fs.statSync(path.join(ext.dir, opts.probe)).isFile()) {
          continue;
        }
      } catch {
        continue;
      }
    }
    return ext;
  }
  return null;
}

/**
 * state 里指向**已不存在的目录**的条目 = 残留。返回它们的 id（本模块不写盘）。
 *
 * 这是「删除目录 → 拓展自动删除」的补齐：目录一删，发现路径立刻看不见它，但
 * `extensions_state.json` 会留一条 `{ enabled: true, installedAt: … }`，让任何按
 * state 枚举的调用点继续报告一个幽灵拓展。
 *
 * @param {object} [opts] - { env }
 * @returns {string[]} 残留条目 id，已排序
 */
function findOrphanState(opts = {}) {
  const state = readState();
  const ids = Object.keys(state).filter((k) => !k.startsWith('__'));
  if (ids.length === 0) {
    return [];
  }
  const live = new Set();
  for (const root of listRoots(opts)) {
    // 与 discover 同深度（§2.3）：拓展可能躺在 <root>/<分类>/<id>。这里若只看一层，
    // 「把拓展移进分类目录」会让在位的拓展被判成残留 —— 而残留名单是要被清理的。
    // 仍用 statSync 而不是 readManifest：manifest 坏掉的拓展目录**在位**，不是残留，
    // 那属于 extension-contract 该报的问题，不该由孤儿清理顺手抹掉。
    const parents = [root.dir, ..._listDirNames(root.dir).map((n) => path.join(root.dir, n))];
    for (const parent of parents) {
      for (const id of ids) {
        try {
          if (fs.statSync(path.join(parent, id)).isDirectory()) {
            live.add(id);
          }
        } catch {
          /* 这一处没有 → 换下一处 */
        }
      }
    }
  }
  return ids.filter((id) => !live.has(id)).sort();
}

module.exports = {
  listRoots,
  repoExtensionsDir,
  userExtensionsDir,
  readManifest,
  discover,
  readState,
  stateFilePath,
  isEnabled,
  findProvider,
  findOrphanState,
  MANIFEST_CANONICAL,
  MANIFEST_LEGACY_JSON,
  MANIFEST_NAMES,
  STATE_FILE_NAME,
  KINDS,
  MAX_DEPTH,
  GATE_REPO_ROOT,
};
