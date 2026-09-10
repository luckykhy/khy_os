'use strict';

/**
 * oeMcpBridge.js — 纯叶子:opencode MCP 配置的单一真源。
 *
 * opencode 是一个开源终端 AI 编程工具,其 MCP 配置存储在:
 *   - ~/.config/opencode/config.json  →  `mcp` 键(标准 mcpServers schema)
 *   - ~/.opencode/config.json         →  同上(备用路径)
 *   - <project>/.opencode/config.json →  项目级配置
 *   - <project>/opencode.json         →  项目级配置(备用)
 *
 * 配置格式(推测,基于 opencode 开源仓库):
 *   {
 *     "mcp": {
 *       "server-name": {
 *         "command": "npx",
 *         "args": ["-y", "..."],
 *         "env": { "KEY": "value" }
 *       }
 *     }
 *   }
 *
 * 契约:零 IO(homedir / env / 已读文件 TEXT 由壳注入)、确定性、绝不抛。
 * 门控 KHY_MCP_ECODE_BRIDGE 默认开;关 → 生态注册表整体跳过 opencode。
 *
 * @module services/mcp/oeMcpBridge
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// ── 门控 ────────────────────────────────────────────────────────────────────

/** KHY_MCP_ECODE_BRIDGE 门控:默认开,{0,false,off,no} 关。 */
function isOeMcpBridgeEnabled(env = process.env) {
  const raw = env && env.KHY_MCP_ECODE_BRIDGE;
  const v = String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase();
  return !_FALSY.has(v);
}

// ── 路径枚举 ────────────────────────────────────────────────────────────────

const _join = require('../../../../utils/pathJoinSafe');

/**
 * 枚举 opencode 的 MCP 配置源(不碰 fs,壳决定存在性 + 读 TEXT)。
 * @param {object} args
 * @param {string} [args.homedir]
 * @param {object} [args.env]
 * @returns {Array<{path:string, kind:string}>}
 */
function oeMcpConfigSources({ homedir, env = process.env } = {}) {
  try {
    const sources = [];
    const cfg = userConfigDir({ homedir, env });
    const home = homedir || '';

    // 全局配置(按优先级)
    if (cfg) {
      sources.push({ path: _join(cfg, 'config.json'), kind: 'user-global' });
    }
    if (home) {
      sources.push({ path: _join(home, '.opencode', 'config.json'), kind: 'user-alt' });
    }

    // 项目级配置(当前工作目录)
    const cwd = process.cwd();
    if (cwd) {
      sources.push({ path: _join(cwd, '.opencode', 'config.json'), kind: 'project' });
      sources.push({ path: _join(cwd, 'opencode.json'), kind: 'project-alt' });
    }

    return sources;
  } catch {
    return [];
  }
}

/** 解析平台配置目录(与 mcpEcosystemRegistry 保持一致)。 */
function userConfigDir({ homedir, env = process.env } = {}) {
  try {
    const plat = process.platform;
    if (plat === 'win32') {
      return env.APPDATA || _join(homedir, 'AppData', 'Roaming');
    }
    if (plat === 'darwin') {
      return _join(homedir, 'Library', 'Application Support');
    }
    return env.XDG_CONFIG_HOME || _join(homedir, '.config');
  } catch {
    return '';
  }
}

// ── 配置解析 ────────────────────────────────────────────────────────────────

/**
 * 容错解析 opencode 配置 TEXT(JSON/JSON5)。
 * @param {string} text
 * @returns {object|null}
 */
function parseConfig(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  // 优先 JSON5(容错注释 + 尾逗号)
  try {
    const JSON5 = require('json5');
    if (JSON5 && typeof JSON5.parse === 'function') {
      const obj = JSON5.parse(text);
      return obj && typeof obj === 'object' ? obj : null;
    }
  } catch {
    /* fallback */
  }
  // 容错 JSON(去注释 + 尾逗号)
  try {
    const stripped = _stripJsonc(text);
    const obj = JSON.parse(stripped);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** 提取 opencode 配置中的 MCP servers 映射。 */
function extractMcpServers(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  // opencode 使用 "mcp" 键(而非 "mcpServers")
  const mcp = parsed.mcp || parsed.mcpServers;
  if (!mcp || typeof mcp !== 'object') {
    return {};
  }
  // 过滤掉非对象值(如 _meta 等)
  const result = {};
  for (const [name, cfg] of Object.entries(mcp)) {
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      result[name] = cfg;
    }
  }
  return result;
}

/** 简易 JSONC 剥离(去 // 和 /* */ 注释 + 尾逗号)。 */
function _stripJsonc(text) {
  if (!text) return '';
  // 去注释
  let result = text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/\/\/[^\n]*/g, '');       // 行注释
  // 去尾逗号(对象/数组最后一个逗号)
  result = result.replace(/,\s*([}\]])/g, '$1');
  return result;
}

// ── 导出 ────────────────────────────────────────────────────────────────────

module.exports = {
  isOeMcpBridgeEnabled,
  oeMcpConfigSources,
  parseConfig,
  extractMcpServers,
};
