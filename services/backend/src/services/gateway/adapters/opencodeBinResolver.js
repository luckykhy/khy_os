'use strict';

/**
 * opencodeBinResolver.js — 解析 opencode 可执行文件的实际路径(单一真源、确定性、绝不抛)。
 *
 * 背景(症状:khy「找 opencode 目录如此费力,不能准确搜索」):opencode 常以**便携方式**
 * 安装在项目 tools 目录下(实证布局:
 *   `<repo>/tools/opencode-portable/node_modules/opencode-ai/bin/opencode(.exe)`),
 * **不在系统 PATH**。而 _commandAvailability 只做 `opencode --version` + PATH `where`
 * 探测 → 便携安装恒探测失败,AI 只能乱试 winget/用户目录,搜错地方。
 *
 * 本叶子把「opencode 到底是哪个可执行文件」收敛为一处:
 *   1. `KHY_OPENCODE_BIN` 显式覆盖(绝对路径,存在即用)—— 任何非常规布局的最终兜底。
 *   2. 便携约定候选:以 `KHY_TOOLS_DIR`(若设)或从 cwd 向上逐级查找的 `tools/` 目录为根,
 *      拼 `tools/opencode-portable/node_modules/opencode-ai/bin/opencode(.exe)`,fs.existsSync
 *      命中即返绝对路径。
 *   3. 全落空 → 返回裸命令 `'opencode'`(逐字节回退到既有 PATH 探测行为)。
 *
 * 契约:除 fs.existsSync / fs.statSync 只读探测外无副作用;确定性(同 env+cwd 同输出);
 * 绝不抛(任何异常 → 安全回退到 'opencode')。
 *
 * 门控 KHY_OPENCODE_BIN_DISCOVERY(默认开,仅显式 0/false/off/no 关闭):关闭后 resolve
 * 恒返回 `'opencode'` —— 逐字节回退到「只认 PATH」的历史行为。
 *
 * @module services/gateway/adapters/opencodeBinResolver
 */

const fs = require('fs');
const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);

const BARE = 'opencode';

/** 便携安装的相对锚点(相对某个 `tools/` 的父目录)。 */
const _PORTABLE_TAIL = ['tools', 'opencode-portable', 'node_modules', 'opencode-ai', 'bin'];

/** 门控:KHY_OPENCODE_BIN_DISCOVERY 默认开,仅显式 0/false/off/no 关闭。 */
function isDiscoveryEnabled(env = process.env) {
  const v = (env || process.env || {}).KHY_OPENCODE_BIN_DISCOVERY;
  return !(v !== undefined && _OFF.has(String(v).trim().toLowerCase()));
}

function _binName() {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function _existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 收集便携候选根:优先 KHY_TOOLS_DIR 的父目录(其自身即 tools/),否则从 cwd 逐级上溯,
 * 每级都作为「可能含 tools/ 的目录」参与拼接。去重、顺序稳定(近的优先)。
 */
function _candidateBases(env, cwd) {
  const bases = [];
  const push = (dir) => { if (dir && !bases.includes(dir)) bases.push(dir); };
  const toolsDir = env && env.KHY_TOOLS_DIR;
  if (typeof toolsDir === 'string' && toolsDir.trim()) {
    // KHY_TOOLS_DIR 指向 tools/ 本身 → 其父目录才是 _PORTABLE_TAIL 的拼接根。
    push(path.dirname(path.resolve(toolsDir.trim())));
  }
  // khy 数据家便携约定(`khy tools install opencode` 落到 ~/.khy/tools/…):
  // _PORTABLE_TAIL[0]==='tools',故拼接根是数据家本身(getDataHome() → ~/.khy)。
  // 只读探测、绝不抛;加载/解析失败静默跳过(继续 cwd 上溯候选)。
  try {
    const { getDataHome } = require('../../../utils/dataHome');
    const home = getDataHome();
    if (typeof home === 'string' && home.trim()) push(path.resolve(home.trim()));
  } catch { /* best effort — 数据家不可用时退回 cwd 上溯 */ }
  let dir = path.resolve(cwd || '.');
  // 逐级上溯(含自身),上限 12 级,避免退化到根目录的无限循环。
  for (let i = 0; i < 12; i += 1) {
    push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return bases;
}

/**
 * 解析 opencode 可执行文件路径。命中便携安装 → 绝对路径;否则裸命令 'opencode'。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
function resolveOpencodeBin(env = process.env, cwd = process.cwd()) {
  try {
    if (!isDiscoveryEnabled(env)) return BARE;
    const explicit = env && env.KHY_OPENCODE_BIN;
    if (typeof explicit === 'string' && explicit.trim()) {
      const abs = path.resolve(explicit.trim());
      if (_existsFile(abs)) return abs;
      // 显式指定但不存在 → 仍尊重用户意图,原样返回(让上游报出清晰的「找不到」)。
      return explicit.trim();
    }
    const bin = _binName();
    for (const base of _candidateBases(env, cwd)) {
      const candidate = path.join(base, ..._PORTABLE_TAIL, bin);
      if (_existsFile(candidate)) return candidate;
    }
    return BARE;
  } catch {
    return BARE;
  }
}

/** 是否解析到了便携安装(而非裸 PATH 命令)。供状态展示/诊断。 */
function isResolvedToPortable(env = process.env, cwd = process.cwd()) {
  const r = resolveOpencodeBin(env, cwd);
  return r !== BARE;
}

module.exports = {
  isDiscoveryEnabled,
  resolveOpencodeBin,
  isResolvedToPortable,
  BARE,
};
