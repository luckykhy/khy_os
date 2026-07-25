'use strict';

/**
 * portableCliResolver.js — 把便携 CLI(claude/codex)解析成一个可直接 spawn 的「启动规格」
 * (确定性只读解析器 / deterministic read-only resolver、绝不抛)。仅做 fs 只读探测,
 * 不写盘、不触网、不改进程状态;因含 fs 只读 require,故不自声明零 IO 契约(对齐 sibling
 * opencodeBinResolver 约定),但仍恪守「同 env+toolsRoot 同输出、任何异常吞成 null」的契约。
 *
 * 背景:claude(@anthropic-ai/claude-code)与 codex(@openai/codex)npm 包发布的是**带
 * node shebang 的 JS 入口**。npm 全局/本地安装时会在 PATH 或 node_modules/.bin 生成 shim
 * (Windows 上是 .cmd/.ps1)。直接 spawn 裸名 `claude`/`codex` 依赖系统 PATH,便携安装在
 * `~/.khy/tools/<pkg>-portable/` 下 → 不在 PATH → 恒 ENOENT(正是用户在 Windows 终端遇到的
 * `spawn codex ENOENT`)。在 Windows 上 spawn .cmd shim 还有 shell/DEP0190 一堆坑。
 *
 * 本叶子绕开全部 shim/PATH 问题:读**已安装包的 package.json 的 bin 字段** → 定位真实 JS 入口 →
 * 返回 `{ command: <node 可执行>, argsPrefix: [<入口绝对路径>] }`,即用当前 Node 直接跑入口脚本。
 * 跨平台一致、不碰 PATH、不碰 .cmd。极少数「入口是原生二进制」的情形按 shebang 嗅探回退为直接执行。
 *
 * 解析顺序(给定 toolKey):
 *   1. 门 KHY_PORTABLE_CLI 关 → 返回 null(逐字节回退:适配器继续用它原有的裸命令 spawn)。
 *   2. 该工具有专用解析器(opencode)→ 返回 null(让给 opencodeBinResolver,不打架)。
 *   3. 显式覆盖 `KHY_<TOOL>_BIN`(绝对路径,存在即用)→ 按类型嗅探成启动规格。
 *   4. 便携安装命中(`<toolsRoot>/<portableDir>/node_modules/<pkg>` 下 package.json.bin 入口存在)
 *      → 启动规格。
 *   5. 全落空 → null(回退裸命令 PATH 行为)。
 *
 * 契约:除 fs 只读探测(existsSync/statSync/readFileSync)外无副作用;确定性(同 env+toolsRoot
 * 同输出);绝不抛(任何异常 → null 安全回退)。
 *
 * @module services/gateway/adapters/portableCliResolver
 */

const fs = require('fs');
const path = require('path');
const registry = require('./portableCliRegistry');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_PORTABLE_CLI 默认开,仅显式 0/false/off/no 关闭。 */
function isPortableEnabled(env = process.env) {
  const v = (env || process.env || {}).KHY_PORTABLE_CLI;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

/** 每工具显式覆盖环境变量名:claude → KHY_CLAUDE_BIN,codex → KHY_CODEX_BIN。 */
function _overrideEnvName(key) {
  return `KHY_${String(key).trim().toUpperCase()}_BIN`;
}

function _existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 解析便携工具根目录。优先 env.KHY_TOOLS_DIR(与 opencodeBinResolver 复用同一约定,
 * 也便于测试注入);否则用注入的 dataHome(生产由适配器传入 getDataDir('tools'))。
 * 二者皆无 → null(无法定位便携根,视为未安装)。
 * @returns {string|null}
 */
function _resolveToolsRoot(env, toolsRoot) {
  const fromEnv = env && env.KHY_TOOLS_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (typeof toolsRoot === 'string' && toolsRoot.trim()) return path.resolve(toolsRoot.trim());
  return null;
}

/** 该工具便携安装的包目录:`<toolsRoot>/<portableDir>/node_modules/<pkg>`。 */
function _packageDir(root, tool) {
  // pkg 可能是 scoped(@anthropic-ai/claude-code);path.join 逐段拼接跨平台正确。
  return path.join(root, tool.portableDir, 'node_modules', ...tool.pkg.split('/'));
}

/**
 * 从已安装包目录读取 package.json 的 bin,定位真实入口绝对路径。
 * bin 为字符串 → 直接用;为对象 → 优先 bin[tool.bin],否则取第一个值。入口不存在 → null。
 * @returns {string|null}
 */
function _entryFromPackage(pkgDir, tool) {
  try {
    const manifest = path.join(pkgDir, 'package.json');
    if (!_existsFile(manifest)) return null;
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const bin = json && json.bin;
    let rel = null;
    if (typeof bin === 'string') rel = bin;
    else if (bin && typeof bin === 'object') rel = bin[tool.bin] || Object.values(bin)[0] || null;
    if (typeof rel !== 'string' || !rel.trim()) return null;
    const abs = path.resolve(pkgDir, rel.trim());
    return _existsFile(abs) ? abs : null;
  } catch {
    return null;
  }
}

/**
 * 判断一个入口应「用 node 跑」还是「直接执行」。
 * node 判据:文件首行含 node shebang(`#!...node`),或扩展名为 .js/.cjs/.mjs。
 * 否则视为原生可执行,直接执行。任何读失败 → 按扩展名兜底(读不到 shebang 也能判 .js)。
 */
function _isNodeEntry(entryAbs) {
  const ext = path.extname(entryAbs).toLowerCase();
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return true;
  try {
    const fd = fs.openSync(entryAbs, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, 128, 0);
      const head = buf.slice(0, n).toString('utf8');
      if (head.startsWith('#!') && /\bnode\b/.test(head.split('\n')[0])) return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* fall through to false */ }
  return false;
}

/** 把一个入口绝对路径包成启动规格(node 入口 → node + 入口;原生 → 直接执行)。 */
function _specForEntry(entryAbs, resolvedFrom) {
  if (_isNodeEntry(entryAbs)) {
    return { command: process.execPath, argsPrefix: [entryAbs], resolvedFrom };
  }
  return { command: entryAbs, argsPrefix: [], resolvedFrom };
}

/**
 * 解析便携 CLI 的启动规格。命中 → { command, argsPrefix, resolvedFrom };无便携/门关/让给专用
 * 解析器/未知工具 → null(调用方回退裸命令)。
 * @param {string} toolKey
 * @param {object} [opts] - { env, toolsRoot }
 * @returns {{command:string,argsPrefix:string[],resolvedFrom:string}|null}
 */
function resolveLaunchSpec(toolKey, opts = {}) {
  try {
    const env = opts.env || process.env;
    if (!isPortableEnabled(env)) return null;
    const tool = registry.getTool(toolKey);
    if (!tool) return null;
    if (registry.hasNativeResolver(tool.key)) return null; // opencode → 专用解析器

    // 3) 显式覆盖:KHY_<TOOL>_BIN 绝对路径存在即用。
    const explicit = env[_overrideEnvName(tool.key)];
    if (typeof explicit === 'string' && explicit.trim()) {
      const abs = path.resolve(explicit.trim());
      if (_existsFile(abs)) return _specForEntry(abs, 'override');
      // 指定但不存在:尊重用户意图,原样直接执行(让上游报清晰错误)。
      return { command: explicit.trim(), argsPrefix: [], resolvedFrom: 'override-missing' };
    }

    // 4) 便携安装命中。
    const root = _resolveToolsRoot(env, opts.toolsRoot);
    if (root) {
      const entry = _entryFromPackage(_packageDir(root, tool), tool);
      if (entry) return _specForEntry(entry, 'portable');
    }
    return null;
  } catch {
    return null;
  }
}

/** 该工具是否已可经便携/覆盖解析(不含裸 PATH)。供适配器 detect 与管理命令使用。 */
function isInstalled(toolKey, opts = {}) {
  return resolveLaunchSpec(toolKey, opts) !== null;
}

/** 该工具便携安装的包目录绝对路径(不判存在);无法定位根 → null。供安装器/诊断使用。 */
function packageDir(toolKey, opts = {}) {
  const tool = registry.getTool(toolKey);
  if (!tool) return null;
  const root = _resolveToolsRoot(opts.env || process.env, opts.toolsRoot);
  return root ? _packageDir(root, tool) : null;
}

/**
 * 给定裸命令回退,解析适配器应实际 spawn 的 (command, args)。纯函数、绝不抛:
 * 便携/覆盖命中 → 用启动规格的 command + argsPrefix 前缀拼上业务 args;
 * 未命中(或门关/专用解析器/未知工具)→ 原样返回调用方给的 fallback.command / fallback.args
 * (逐字节回退 = 适配器既有裸命令 spawn 行为)。
 *
 * 这样把「便携优先、否则回退」的判定收进纯叶子,适配器改动仅数行且可单测,
 * 不必在 god-file 里塞条件分支(codex/claude 都逼近 2500 行上限)。
 *
 * @param {string} toolKey
 * @param {string[]} args - 业务参数(spawn 的可变尾部)
 * @param {object} [opts] - { env, toolsRoot, fallback:{command,args} }
 * @returns {{command:string, args:string[], resolvedFrom:string}}
 */
function resolveSpawn(toolKey, args = [], opts = {}) {
  const fb = (opts && opts.fallback) || {};
  const fbArgs = fb.args !== undefined ? fb.args : (Array.isArray(args) ? args : []);
  try {
    const spec = resolveLaunchSpec(toolKey, opts);
    if (spec) {
      return {
        command: spec.command,
        args: [...spec.argsPrefix, ...(Array.isArray(args) ? args : [])],
        resolvedFrom: spec.resolvedFrom,
      };
    }
  } catch { /* fall through to fallback */ }
  return { command: fb.command, args: fbArgs, resolvedFrom: 'fallback' };
}

module.exports = {
  isPortableEnabled,
  resolveLaunchSpec,
  resolveSpawn,
  isInstalled,
  packageDir,
};
