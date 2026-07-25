/**
 * Command Registry — extensible, priority-based slash command system.
 *
 * Replaces the static SLASH_COMMANDS array with a dynamic registry that
 * supports registration from multiple sources (builtin, tools, plugins, MCP).
 *
 * Higher priority sources win on collision. Categories group commands
 * for display in the `/` menu.
 *
 * Falls back gracefully — router.js keeps _STATIC_SLASH_COMMANDS as safety net.
 */

// ── Priority levels (higher wins on collision) ────────────────────

const PRIORITY = {
  builtin: 100,
  tool: 80,
  plugin: 60,
  mcp: 40,
  user: 20,
};

// ── Category definitions ──────────────────────────────────────────

const CATEGORIES = {
  model:    'AI \u6a21\u578b',     // AI 模型
  data:     '\u6570\u636e\u7ba1\u7406', // 数据管理
  security: '\u5b89\u5168',       // 安全
  dev:      '\u5f00\u53d1\u5de5\u5177', // 开发工具
  workflow: '\u5de5\u4f5c\u6d41',   // 工作流
  system:   '\u7cfb\u7edf',       // 系统
};

// ── Registry state ────────────────────────────────────────────────

const _commands = new Map(); // cmd → { cmd, label, desc, route, flag, category, priority, source }
let _categoryCache = null;   // invalidated on mutation

const { getStaticSlashCommands } = require('../constants/commandSchema');

// getCompletions 的小写键投影按注册表身份记忆(避免每次调用对全量键 toLowerCase + sort)。
// 门控关 → 现算(逐字节回退)。惰性 require 避免加载期环依赖。
let _completionIndexMemo;
const completionIndexMemo = () => (_completionIndexMemo ??= require('./commandCompletionIndexMemo'));

// ── Category assignment for builtin commands ─────────────────────

const _builtinCategories = {
  '/model': 'model', '/models': 'model', '/gateway': 'model', '/apikey': 'model',
  '/max': 'model', '/high': 'model', '/medium': 'model', '/low': 'model',

  '/cost': 'data', '/history': 'data', '/prompt': 'data',
  '/knowledge': 'data', '/growth': 'data',

  '/permissions': 'security', '/security': 'security', '/scan': 'security',
  '/login': 'security', '/logout': 'security', '/whoami': 'security',

  '/review': 'dev', '/doctor': 'dev', '/hardware': 'dev',
  '/clipboard': 'dev', '/websearch': 'dev', '/image': 'dev', '/paste': 'dev', '/image2web': 'dev',
  '/publish': 'dev',

  '/agent': 'workflow', '/skill': 'workflow', '/plan': 'workflow',
  '/ulw-loop': 'workflow', '/cron': 'workflow',
  '/profile': 'workflow', '/habit': 'workflow', '/resume': 'workflow',
  '/memory': 'workflow', '/proxy': 'workflow', '/subscribe': 'workflow',

  '/linux': 'system', '/skin': 'system',
  '/help': 'system', '/clear': 'system', '/exit': 'system',
  '/update': 'system', '/cleanup': 'system',
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Register a single command definition.
 * Lower priority sources do NOT overwrite higher priority ones.
 *
 * @param {object} cmdDef - { cmd, label, desc, route?, flag?, category? }
 * @param {string} [source='user'] - Source identifier (builtin|tool|plugin|mcp|user)
 */
function register(cmdDef, source = 'user') {
  if (!cmdDef || !cmdDef.cmd) return;
  const priority = PRIORITY[source] ?? PRIORITY.user;

  const existing = _commands.get(cmdDef.cmd);
  if (existing && existing.priority > priority) return; // higher priority already registered

  _commands.set(cmdDef.cmd, {
    cmd: cmdDef.cmd,
    label: cmdDef.label || cmdDef.cmd.slice(1),
    desc: cmdDef.desc || '',
    route: cmdDef.route || null,
    flag: cmdDef.flag || null,
    category: cmdDef.category || _builtinCategories[cmdDef.cmd] || 'system',
    priority,
    source,
    // Plugin SDK fields (preserved for dispatch)
    _pluginHandler: cmdDef._pluginHandler || null,
    _pluginNamespace: cmdDef._pluginNamespace || null,
    _aliases: cmdDef._aliases || null,
    _completer: cmdDef._completer || null,
    // 用户自建技能(~/.khy/skills)派发所需:技能目录与名字(供选中时读 prompt.md 执行)。
    _skillDir: cmdDef._skillDir || null,
    _skillName: cmdDef._skillName || null,
    // Claude Code 自定义斜杠命令(~/.claude/commands 等)派发所需:命令文件路径 + 参数提示。
    _commandFile: cmdDef._commandFile || null,
    _commandName: cmdDef._commandName || null,
    _argumentHint: cmdDef._argumentHint || null,
  });
  _categoryCache = null;
}

/**
 * Bulk-register commands from a single source.
 *
 * @param {Array} commands - Array of command definitions
 * @param {string} [source='builtin'] - Source identifier
 */
function registerBulk(commands, source = 'builtin') {
  if (!Array.isArray(commands)) return;
  for (const cmd of commands) {
    register(cmd, source);
  }
}

/**
 * Get all commands sorted by category then priority.
 * @returns {Array}
 */
function getAll() {
  const arr = [..._commands.values()];
  arr.sort((a, b) => {
    const catOrder = Object.keys(CATEGORIES);
    const catA = catOrder.indexOf(a.category);
    const catB = catOrder.indexOf(b.category);
    if (catA !== catB) return (catA === -1 ? 999 : catA) - (catB === -1 ? 999 : catB);
    return b.priority - a.priority;
  });
  return arr;
}

/**
 * Get commands grouped by category.
 * @returns {object} { model: [...], data: [...], ... }
 */
function getByCategory() {
  if (_categoryCache) return _categoryCache;

  const grouped = {};
  for (const cat of Object.keys(CATEGORIES)) {
    grouped[cat] = [];
  }

  for (const cmd of _commands.values()) {
    const cat = cmd.category;
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(cmd);
  }

  // Sort each group by priority desc
  for (const cat of Object.keys(grouped)) {
    grouped[cat].sort((a, b) => b.priority - a.priority);
  }

  // Remove empty categories
  for (const cat of Object.keys(grouped)) {
    if (grouped[cat].length === 0) delete grouped[cat];
  }

  _categoryCache = grouped;
  return grouped;
}

/**
 * Tab-completion: return commands matching a partial prefix.
 * @param {string} partial - e.g. '/mo'
 * @returns {string[]} - e.g. ['/model', '/models']
 */
function getCompletions(partial) {
  if (!partial) return [];
  const lower = partial.toLowerCase();
  // 排序小写键投影按注册表 (身份, size) 记忆;门控关/异常 → 现算(逐字节回退)。
  // 投影按 cmd 升序,过滤子序列天然有序 → 免去每次调用的 matches.sort()。
  const index = completionIndexMemo().getCompletionIndex(_commands, () => {
    const proj = [];
    for (const cmd of _commands.keys()) proj.push({ cmd, cmdLower: cmd.toLowerCase() });
    proj.sort((a, b) => (a.cmd < b.cmd ? -1 : a.cmd > b.cmd ? 1 : 0));
    return proj;
  }, process.env);
  const matches = [];
  for (let i = 0; i < index.length; i++) {
    if (index[i].cmdLower.startsWith(lower)) matches.push(index[i].cmd);
  }
  return matches;
}

/**
 * Unregister a command by name.
 * @param {string} cmd
 */
function unregister(cmd) {
  _commands.delete(cmd);
  _categoryCache = null;
}

/**
 * Convert to the legacy SLASH_COMMANDS array format for backward compatibility.
 * @returns {Array<{cmd, label, desc, route, flag}>}
 */
function toSlashCommands() {
  return getAll().map(({ cmd, label, desc, route, flag }) => ({ cmd, label, desc, route, flag }));
}

/**
 * Clear internal caches (call when tools/plugins change).
 */
function clearCache() {
  _categoryCache = null;
}

/**
 * Get the total number of registered commands.
 * @returns {number}
 */
function count() {
  return _commands.size;
}

function _seedBuiltins() {
  registerBulk(getStaticSlashCommands(), 'builtin');
}

/**
 * 发现并注册「用户自建技能」为斜杠命令(供 TUI SLASH_COMMANDS / REPL 面板统一可见)。
 *
 * REPL 侧 `_getSlashCommands()` 每次现扫用户技能;TUI 侧 SLASH_COMMANDS 由本注册表快照生成,
 * 故需在启动时把技能并入注册表,两个界面同一真源。绝不抛:发现失败静默跳过,不影响内置命令。
 * 门控 KHY_USER_SKILL_MENU 关时 listUserSkillCommands 返 [] → 无操作(逐字节回退今日行为)。
 *
 * @param {object} [opts] - 透传给 listUserSkillCommands(env/cwd/home/builtinDir,便于单测)
 * @returns {number} 注册的技能命令数
 */
function registerUserSkills(opts = {}) {
  let list = [];
  try {
    list = require('./repl/userSkillCommands').listUserSkillCommands(opts);
  } catch { return 0; }
  if (!Array.isArray(list) || list.length === 0) return 0;
  // source='user':优先级低于 builtin,内置命令名冲突时不被技能覆盖(register 内部按优先级守卫)。
  registerBulk(list, 'user');
  return list.length;
}

/**
 * 发现并注册「Claude Code 自定义斜杠命令」(~/.claude/commands 等)为 khy 斜杠命令。
 *
 * 与 registerUserSkills 同构:把第三方 CC 命令包(`.claude/commands/*.md`)并入注册表,
 * 使 TUI SLASH_COMMANDS / REPL 面板两界面同一真源可见。绝不抛:发现失败静默跳过,不影响内置命令。
 * 门控 KHY_CC_COMMAND_BRIDGE 关时 listCcCommands 返 [] → 无操作(逐字节回退今日行为)。
 * source='user':优先级低于 builtin,与内置命令重名时不覆盖内置(register 内部按优先级守卫)。
 *
 * @param {object} [opts] - 透传给 listCcCommands(env/cwd/home,便于单测)
 * @returns {number} 注册的 CC 命令数
 */
function registerCcCommands(opts = {}) {
  let list = [];
  try {
    list = require('./repl/ccUserCommands').listCcCommands(opts);
  } catch { return 0; }
  if (!Array.isArray(list) || list.length === 0) return 0;
  registerBulk(list, 'user');
  return list.length;
}

// Lazy initialization flag
let _seeded = false;
function _ensureSeeded() {
  if (_seeded) return;
  _seeded = true;
  _seedBuiltins();
}

// Wrap public methods with lazy seeding
const _wrapped = {};
for (const fn of [getAll, getByCategory, getCompletions, toSlashCommands, count]) {
  _wrapped[fn.name] = function (...args) {
    _ensureSeeded();
    return fn(...args);
  };
}

// ── Exports ───────────────────────────────────────────────────────

module.exports = {
  register,
  registerBulk,
  registerUserSkills,
  registerCcCommands,
  getAll: _wrapped.getAll,
  getByCategory: _wrapped.getByCategory,
  getCompletions: _wrapped.getCompletions,
  toSlashCommands: _wrapped.toSlashCommands,
  count: _wrapped.count,
  unregister,
  clearCache,
  PRIORITY,
  CATEGORIES,
};
