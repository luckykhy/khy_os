'use strict';

/**
 * selfLocation.js — 「khy 知道自己装在哪 + 自己有哪些功能」的纯叶子。
 *
 * goal「khy 要清楚地知道自己有什么功能，安装在哪里，不要让它调用自身的功能还
 * 找半天找不到，或者搜索自身的文件也是」的单一真源。
 *
 * 背景(带证据):
 *   - agent 的系统提示注入了**工具**(toolCalling.getToolDefinitions)却从不注入
 *     **命令目录**(commandSchema.getBuiltinSlashCommands ~200 条),模型要调用
 *     斜杠命令只能猜名字 → 「调用自身功能找不到」。
 *   - selfProfile.formatForSystemPrompt 从不告诉模型 khy 装在哪 →「搜索自身文件找不到」。
 *   - 关键事实:GrepTool 对**绝对路径**忽略 cwd(path.resolve(cwd, abs) === abs),
 *     所以模型只要知道自身**绝对源码目录**,就能直接 Grep/Glob/Read 自身代码,
 *     无需新增搜索能力。因此本问题塌缩为「把自知注入系统提示」。
 *
 * 契约(leaf-contract):零重 IO(纯字符串派生)、确定性、绝不抛、门控
 * KHY_SELF_LOCATION 默认开(关 → 定位/命令概览两块产出 ''，逐字节回退到今日行为)。
 * 定位所需的真实路径(appRoot / selfSrcDir / 各 home)由**调用方注入**(selfProfile
 * 用 dataHome 解析器取真值再传入),本叶子只做派生与格式化,可测且零耦合。
 */

/** 关闭词表(对齐仓库既有门控约定)。 */
const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/**
 * 自我定位注入是否启用。默认开;仅当 KHY_SELF_LOCATION 显式置关闭词才禁用。
 * @param {object} [env]
 * @returns {boolean}
 */
function selfLocationEnabled(env = process.env) {
  try {
    const raw = String((env && env.KHY_SELF_LOCATION) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/** 稳定字符串化(去两端空白;非字符串 → '')。 */
// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _s = require('../utils/trimIfString');

/**
 * 由安装根路径的字符串标记派生安装类型(纯字符串判定,零 IO)。
 *   - 含 node_modules              → 'npm'
 *   - 含 site-packages 或 /bundled/ → 'pip'   (pip wheel 布局 platform/khy_os/bundled/...)
 *   - 否则                         → 'dev'   (源码树/开发克隆)
 * @param {string} appRoot
 * @returns {'npm'|'pip'|'dev'}
 */
function classifyInstallKind(appRoot) {
  const p = _s(appRoot);
  if (!p) return 'dev';
  const norm = p.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/node_modules/') || norm.endsWith('/node_modules')) return 'npm';
  if (norm.includes('site-packages') || norm.includes('/bundled/') || norm.endsWith('/bundled')) return 'pip';
  return 'dev';
}

/**
 * 解析 khy 的自我定位事实(纯派生;真实路径由调用方注入)。
 *
 * @param {object} deps
 * @param {string} deps.appRoot          安装/项目根(dataHome.getAppRoot())
 * @param {string} deps.selfSrcDir       自身源码目录(services/backend/src) —— agent 该在此 grep
 * @param {string} [deps.dataHome]       数据主目录
 * @param {string} [deps.projectDataHome] 项目数据目录(会话/DB/记忆)
 * @param {string} [deps.baseHome]       生态底座目录
 * @param {object} [env]
 * @returns {{appRoot,selfSrcDir,dataHome,projectDataHome,baseHome,installKind}}
 */
function resolveSelfLocation(deps = {}, env = process.env) {
  const appRoot = _s(deps.appRoot);
  const selfSrcDir = _s(deps.selfSrcDir);
  return {
    appRoot,
    selfSrcDir,
    dataHome: _s(deps.dataHome),
    projectDataHome: _s(deps.projectDataHome),
    baseHome: _s(deps.baseHome),
    installKind: classifyInstallKind(appRoot),
    enabled: selfLocationEnabled(env),
  };
}

/**
 * 定位块 → 系统提示片段(紧凑,几行)。让 agent 知道自身绝对源码目录,从而能直接
 * 用 Grep/Glob/Read 搜索/读取自身代码(GrepTool 对绝对路径忽略 cwd)。
 * 门控关 / 无有效路径 → '' (字节回退)。
 * @param {object} loc resolveSelfLocation 的返回
 * @param {object} [env]
 * @returns {string}
 */
function formatLocationForSystemPrompt(loc, env = process.env) {
  if (!selfLocationEnabled(env)) return '';
  if (!loc || typeof loc !== 'object') return '';
  const src = _s(loc.selfSrcDir);
  const root = _s(loc.appRoot);
  if (!src && !root) return '';

  const lines = ['## Your install location (search your own source here)'];
  if (src) {
    lines.push(`- Source: ${src}  (to inspect your own code, pass this ABSOLUTE path to Grep/Glob/Read — they honor absolute paths outside the user's cwd)`);
  }
  const rootBits = [];
  if (root) rootBits.push(`Install root: ${root} (${loc.installKind || 'dev'})`);
  if (_s(loc.dataHome)) rootBits.push(`Data home: ${loc.dataHome}`);
  if (rootBits.length) lines.push(`- ${rootBits.join('  ·  ')}`);
  lines.push('- To introspect yourself on demand (list/search your own commands, re-resolve these paths), call the KhySelf tool.');
  return lines.join('\n');
}

/**
 * 命令目录 → 系统提示片段(概览:分类 + 计数 + 每类少量示例 + 全量入口)。
 * 不 dump 全部命令(token 高效),只让 agent 知道「自己有哪些功能类别、怎么查全量」,
 * 从而不再猜命令名。门控关 / 空目录 → '' (字节回退)。
 *
 * @param {object} catalog buildCommandCatalog() 的返回 {categories:[{label,commands:[{cmd,...}]}],total}
 * @param {object} [env]
 * @param {object} [opts]
 * @param {number} [opts.perCategory=4] 每类示例命令数上限
 * @returns {string}
 */
function formatCommandOverviewForSystemPrompt(catalog, env = process.env, opts = {}) {
  if (!selfLocationEnabled(env)) return '';
  if (!catalog || typeof catalog !== 'object') return '';
  const cats = Array.isArray(catalog.categories) ? catalog.categories : [];
  if (cats.length === 0) return '';
  const perCategory = Number.isFinite(opts.perCategory) && opts.perCategory > 0 ? opts.perCategory : 4;

  const total = Number.isFinite(catalog.total) ? catalog.total : 0;
  const lines = [`## Your own commands (${total} total — you can invoke these, don't guess names)`];
  for (const cat of cats) {
    if (!cat || typeof cat !== 'object') continue;
    const label = _s(cat.label) || _s(cat.key);
    const cmds = Array.isArray(cat.commands) ? cat.commands : [];
    const names = cmds
      .map(c => _s(c && c.cmd))
      .filter(Boolean)
      .slice(0, perCategory);
    if (names.length === 0) continue;
    const more = cmds.length > names.length ? `, +${cmds.length - names.length}` : '';
    lines.push(`- ${label}: ${names.join(', ')}${more}`);
  }
  if (lines.length === 1) return '';
  lines.push('Full catalog: run `/features` (TUI) or GET /api/commands.');
  return lines.join('\n');
}

module.exports = {
  selfLocationEnabled,
  classifyInstallKind,
  resolveSelfLocation,
  formatLocationForSystemPrompt,
  formatCommandOverviewForSystemPrompt,
  _OFF, // exported for tests
};
