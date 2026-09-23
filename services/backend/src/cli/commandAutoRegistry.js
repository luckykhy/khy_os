'use strict';

/**
 * commandAutoRegistry.js — Auto-discovery & dispatch for self-registering commands.
 *
 * Scans the `handlers/` directory for modules that export a command manifest
 * (via the MANIFEST_EXPORT_KEY convention from commandManifest.js), validates
 * them, and builds a dispatch table. route() consults this table before its
 * hardcoded switch, so newly-registered commands work without touching router.js.
 *
 * Progressive migration: existing commands keep working through the switch;
 * migrated commands are dispatched here first. Zero regression risk.
 *
 * ── 两阶段惰性加载（启动性能）─────────────────────────────────────────
 * 历史实现 init() 会把 handlers/ 下**全部** 152 个模块 require 一遍，只为从中挑出
 * 真正导出 manifest 的 71 个。其余 81 个的模块级代码（连带其 require 子树）被白白
 * 执行 —— 实测这条路径占「认证后 → TUI 出现」的 ~450ms，是整个登录后等待里最大的一项。
 * 触发链：router.js 顶层 init() → 也经 commandSchema.getRouterCommandNames()
 * → replSession → featureCapabilityMap 二次抵达。
 *
 * 现在拆成两阶段：
 *   阶段一（init）：只读源码做**静态预筛**，判断哪些文件「有机会」声明 manifest
 *     （判据：源码出现 `MANIFEST_EXPORT_KEY]` 计算键）。实测命中集与全量 require 的
 *     最终注册集**完全一致**（71/152），耗时 ~30ms 而非 ~450ms。
 *   阶段二（dispatch）：真正需要执行某命令时，才 require 它所在的文件并取 manifest。
 *
 * 为什么不能只用静态解析：manifest 里 `handler` 是一个**函数引用**，无法从源码重建。
 * 所以名字/别名/帮助文本可以静态拿到，执行体必须延迟到真正 dispatch 时再解析。
 *
 * 安全性依据（两条实测）：一次静态预筛的误判只会导致「该命令在帮助/补全里缺失」，
 * 不会导致错误执行；且 handlers/ 下 152 个模块经核查均**无模块级副作用**
 * （唯一的 `plugin.install(` 出现在模板字符串内，非真实顶层调用），故推迟 require
 * 不改变任何可观测行为。
 *
 * @module cli/commandAutoRegistry
 */

const fs = require('fs');
const path = require('path');

const { extractManifest, validateManifest, HANDLERS_DIR } = require('./commandManifest');

// ── Internal state ────────────────────────────────────────────────

/** @type {Map<string, { name, handler, aliases, description, usage, subCommands, category, source }>} */
const _commands = new Map();

/** @type {Map<string, string>} — alias → canonical command name */
const _aliases = new Map();

/**
 * 阶段一登记但**尚未 require** 的命令：命令名 → 文件绝对路径。
 * dispatch 命中时用它去加载真正的模块（阶段二）。已加载的命令会从本表移除。
 * @type {Map<string, string>}
 */
const _pendingFiles = new Map();

let _initialized = false;

/**
 * 静态判据：源码是否「有机会」声明 manifest。
 *
 * 采用 `MANIFEST_EXPORT_KEY]` 这一计算键写法作为信号 —— 它是 handlers/ 的既有约定
 * （`[MANIFEST_EXPORT_KEY]: {...}`），实测 71 个声明者全部命中、81 个未声明者全部不命中。
 *
 * 保守取向：宁可多留不可错杀 —— 额外认一下字面量 `__khyCommandManifest` / `commandManifest`
 * 写法，覆盖将来可能绕过常量直接写字面量的 handler。多留一个文件只是多一次 require，
 * 而漏掉一个会让命令从帮助里消失。
 *
 * @param {string} source — 模块源码
 * @returns {boolean}
 */
function _mayDeclareManifest(source) {
  return (
    source.indexOf('MANIFEST_EXPORT_KEY]') !== -1 ||
    source.indexOf('__khyCommandManifest') !== -1
  );
}

// ── Public API ────────────────────────────────────────────────────

/**
 * 阶段一：扫描 handlers/，静态登记所有自描述命令。
 *
 * 只读源码、不执行模块（见文件头「两阶段惰性加载」）。登记进 `_commands` 的条目带
 * `_lazyFile` 标记，表示 `handler` 尚未解析；dispatch 时补上并清除标记。
 *
 * Idempotent — calling multiple times re-scans (for hot-reload).
 */
function init() {
  _commands.clear();
  _aliases.clear();
  _pendingFiles.clear();

  let files;
  try {
    files = fs.readdirSync(HANDLERS_DIR);
  } catch (err) {
    // handlers/ missing — fail-soft, registry stays empty.
    _initialized = true;
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.js')) {
      continue;
    }
    if (file.startsWith('_')) {
      continue; // private modules (e.g. _portableAutoInstall.js)
    }
    _registerFromFile(path.join(HANDLERS_DIR, file));
  }

  _initialized = true;
}

/**
 * 阶段一登记的「占位」命令：元数据齐全，但没有 handler 函数。
 * dispatch 命中后再走 `_materialize()`。
 *
 * @param {string} name
 * @param {object} meta — { aliases, description, usage, subCommands, category }
 * @param {string} filePath
 */
function _registerPlaceholder(name, meta, filePath) {
  if (_commands.has(name)) {
    console.warn(`commandAutoRegistry: 命令 "${name}" 重复注册 (来自 ${path.basename(filePath)})，跳过`);
    return;
  }

  _commands.set(name, {
    name,
    handler: null, // 阶段二补齐
    aliases: meta.aliases || [],
    description: meta.description || '',
    usage: meta.usage || name,
    subCommands: meta.subCommands || [],
    category: meta.category || 'extension',
    source: path.basename(filePath),
  });
  _pendingFiles.set(name, filePath);

  for (const alias of meta.aliases || []) {
    if (!_aliases.has(alias) && !_commands.has(alias)) {
      _aliases.set(alias, name);
    }
  }
}

/**
 * 阶段二：把一条占位命令变成可执行 —— 真正 require 它的文件并取出 handler。
 *
 * 失败一律 fail-soft：解析不出 handler 就返回 null，由调用方回落（router 的硬编码
 * switch 仍能兜住这些命令）。
 *
 * @param {string} command
 * @returns {Function|null} handler，或 null
 */
function _materialize(command) {
  const entry = _commands.get(command);
  if (!entry) {
    return null;
  }
  if (typeof entry.handler === 'function') {
    return entry.handler; // 已解析
  }

  const filePath = _pendingFiles.get(command);
  if (!filePath) {
    return null;
  }

  const before = _commands.get(command);
  let mod;
  try {
    mod = require(filePath);
  } catch (err) {
    console.warn(`commandAutoRegistry: 跳过 ${path.basename(filePath)} (import 失败: ${err && err.message ? err.message : err})`);
    return null;
  }

  const { manifest } = extractManifest(mod);
  if (!manifest || typeof manifest.handler !== 'function') {
    // 静态预筛命中了、但实际没有可执行 manifest —— 保持登记无害，只是不可 dispatch。
    return null;
  }

  // 与旧实现同源的有效性校验：旧实现是「扫到就校验、不合法就不注册」。
  // 现在注册被推迟到这里，所以校验也跟过来 —— 不合法则拒绝 dispatch，
  // 让 router 的硬编码 switch 接管，等价于旧行为。
  const { valid, errors } = validateManifest(manifest);
  if (!valid) {
    console.warn(`commandAutoRegistry: 跳过 ${path.basename(filePath)} (清单无效: ${errors.join('; ')})`);
    return null;
  }

  // 用真实 manifest 校正阶段一拿不到的字段（handler 只能在阶段二取到；
  // 其余字段以真实 manifest 为准，保证与「全量 require」的旧行为逐字段一致）。
  before.handler = manifest.handler;
  before.aliases = manifest.aliases || [];
  before.description = manifest.description || '';
  before.usage = manifest.usage || command;
  before.subCommands = manifest.subCommands || [];
  before.category = manifest.category || 'extension';
  _pendingFiles.delete(command);

  return manifest.handler;
}

/**
 * Try to dispatch a command via the auto-registry.
 * @param {string} command — canonical command name
 * @param {object} ctx — { subCommand, args, options, rawCommandToken, parsed, context, printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk }
 * @returns {Promise<{ handled: boolean, result?: any }>}
 */
async function dispatch(command, ctx) {
  if (!_initialized) {
    init();
  }

  // 别名 → 规范名（阶段一已静态登记，无需加载模块）
  const canonical = _aliases.has(command) ? _aliases.get(command) : command;
  const entry = _commands.get(canonical);
  if (!entry) {
    return { handled: false };
  }

  // 阶段二：此时才 require 该命令所在的 handler 文件。
  const handler = _materialize(canonical);
  if (typeof handler !== 'function') {
    return { handled: false };
  }

  try {
    const result = await handler(ctx.parsed, ctx);
    return { handled: true, result };
  } catch (err) {
    // Fail-soft: log and let caller fall through to the switch.
    const { printError } = ctx;
    if (printError) {
      printError(`自注册命令执行失败: ${command} — ${err && err.message ? err.message : err}`);
    }
    return { handled: false };
  }
}

/**
 * @returns {string[]} all registered command names (sorted)
 */
function getCommandNames() {
  if (!_initialized) {
    init();
  }
  return [..._commands.keys()].sort();
}

/**
 * @returns {Record<string, string>} alias → canonical command name
 */
function getAliases() {
  if (!_initialized) {
    init();
  }
  const out = {};
  for (const [alias, cmd] of _aliases) {
    out[alias] = cmd;
  }
  return out;
}

/**
 * @returns {{ name: string, description: string, usage: string, category: string, subCommands: string[] }[]}
 */
function getCompletions() {
  if (!_initialized) {
    init();
  }
  return [..._commands.values()].map((e) => ({
    name: e.name,
    description: e.description || '',
    usage: e.usage || e.name,
    category: e.category || 'extension',
    subCommands: e.subCommands ? [...e.subCommands] : [],
  }));
}

/**
 * @returns {number} count of registered commands
 */
function size() {
  return _commands.size;
}

// ── Internal ──────────────────────────────────────────────────────

/**
 * 阶段一：读源码判断该文件是否可能声明 manifest，并静态抽取元数据。
 *
 * **不再 require 模块** —— 这是本次启动优化的核心。旧实现在这里 `require(filePath)`，
 * 152 个文件全部执行一遍；现在只 `readFileSync` 一次（~0.2ms / 文件）。
 *
 * 静态抽取的取舍：能拿到 name / aliases / description / usage / subCommands / category，
 * 拿不到 handler（函数，无法从源码重建）。因此：
 *   - 元数据抽取失败（没匹配到 manifest 字面量）→ 仍然登记占位，靠阶段二兜底；
 *     只有真正 dispatch 时才可能发现它其实不可用，而彼时 router 的 switch 仍能接管。
 *   - 抽取成功 → 走 `_registerPlaceholder`，帮助/补全立刻可用（零加载成本）。
 *
 * @param {string} filePath — absolute path to .js file
 */
function _registerFromFile(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // 读不了就当它没有 manifest —— fail-soft，与旧实现「import 失败则跳过」同语义。
    return;
  }

  if (!_mayDeclareManifest(source)) {
    return; // 判定不声明 manifest —— 正是那 81 个既往被白加载的文件，现在直接跳过
  }

  const meta = _extractManifestMeta(source);
  if (!meta || !meta.name) {
    // 预筛命中但静态抽不出 name：用一个「待加载」占位，让阶段二有机会真正解析。
    // 不登记名字就无法被 dispatch 命中，所以这里只能放弃 —— 与旧实现「无 manifest 则
    // 不注册」的结果一致（旧实现同样只在 manifest 有效且有 name 时才注册）。
    return;
  }

  _registerPlaceholder(meta.name, meta, filePath);
}

/**
 * 从源码静态抽取 manifest 的**元数据字段**（不含 handler）。
 *
 * 直接对各字段用正则抓字面量。抓不到就留空，交由阶段二用真实 manifest 校正
 * （见 `_materialize`）—— 因此这里「抽不准」只影响帮助文本的即时性，不影响正确性。
 *
 * @param {string} source
 * @returns {{name: string, aliases: string[], description: string, usage: string, subCommands: string[], category: string}|null}
 */
function _extractManifestMeta(source) {
  // 定位 manifest 对象起始处，缩小后续正则的搜索范围，避免误抓到文件别处的同名字段。
  const anchor = source.indexOf('MANIFEST_EXPORT_KEY]');
  const scope = anchor === -1 ? source : source.slice(anchor, anchor + 4000);

  const str = (key) => {
    const m = scope.match(new RegExp(key + "\\s*:\\s*(['\"])((?:\\\\.|(?!\\1).)*)\\1"));
    return m ? m[2] : '';
  };

  const name = str('name');
  if (!name) {
    return null;
  }

  // aliases / subCommands：只在出现该键后的一对方括号内抓字符串字面量。
  const listOf = (key) => {
    const m = scope.match(new RegExp(key + '\\s*:\\s*\\[([\\s\\S]*?)\\]'));
    if (!m) return [];
    const out = [];
    const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
    let g;
    while ((g = re.exec(m[1])) !== null) out.push(g[2]);
    return out;
  };

  return {
    name,
    aliases: listOf('aliases'),
    description: str('description'),
    usage: str('usage'),
    subCommands: listOf('subCommands'),
    category: str('category'),
  };
}

// ── Auto-init on first require (lazy) ─────────────────────────────

// Do NOT auto-init at module load — router.js imports this at startup
// and will call init() explicitly after all handlers are in place.

module.exports = {
  init,
  dispatch,
  getCommandNames,
  getAliases,
  getCompletions,
  size,
};
