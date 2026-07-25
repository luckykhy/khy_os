'use strict';

/**
 * mcpConfigStore.js — 薄 IO 层:往 khy 的 MCP 配置文件(mcp.json)写入/删除一台 server。
 *
 * 定位(GOAL「khy 无生态,需连外部;如 mcp 安装」):services/mcp/index.js 的 saveConfig 只写 user 文件
 * 且把整个内存 config(含 CC-bridge、project 来源)一股脑写回 user 文件——不适合「只增删一台 server」的
 * 精细操作(会把别处来源的 server 复制进 user 文件)。故本模块提供**按 scope 定点读改写**:
 *   - user  → ~/.khy/mcp.json(与 index.js CONFIG_PATHS.user 同路径,loadConfig 会读到)
 *   - project → <cwd>/.khy/mcp.json(与 loadConfig 的 project 源同路径)
 * 只触碰目标文件的 mcpServers[name] 一个键,其余 server 与顶层字段原样保留。
 *
 * homedir/cwd 可注入(默认 os.homedir()/process.cwd())便于单测重定向到临时目录——因 mcp.json 路径基于
 * os.homedir() 而非 getDataHome(),KHY_DATA_HOME 不影响它。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 解析某 scope 的 mcp.json 绝对路径。
 * @param {'user'|'project'} scope
 * @param {{homedir?:string, cwd?:string}} [io]
 * @returns {string}
 */
function scopePath(scope, io = {}) {
  const home = io.homedir || os.homedir();
  const cwd = io.cwd || process.cwd();
  if (scope === 'project') return path.join(cwd, '.khy', 'mcp.json');
  return path.join(home, '.khy', 'mcp.json');
}

/**
 * 读取某文件的配置(缺失/损坏 → 空壳 {mcpServers:{}})。保留未知顶层字段。
 * @param {string} filePath
 * @returns {{mcpServers:object, [k:string]:any}}
 */
function readConfigFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { mcpServers: {} };
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object') return { mcpServers: {} };
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') raw.mcpServers = {};
    return raw;
  } catch {
    // 损坏文件不覆盖:抛给调用方决定(避免静默吃掉用户已有配置)。
    throw new Error(`无法解析已存在的 MCP 配置文件(可能损坏):${filePath}`);
  }
}

function _writeConfigFile(filePath, config) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * 增/改一台 server(同名覆盖)。
 * @param {string} name
 * @param {object} serverConfig
 * @param {{scope?:'user'|'project', homedir?:string, cwd?:string}} [opts]
 * @returns {{path:string, replaced:boolean}}
 */
function addServer(name, serverConfig, opts = {}) {
  const scope = opts.scope === 'project' ? 'project' : 'user';
  const filePath = scopePath(scope, opts);
  const config = readConfigFile(filePath);
  const replaced = Object.prototype.hasOwnProperty.call(config.mcpServers, name);
  config.mcpServers[name] = serverConfig;
  _writeConfigFile(filePath, config);
  return { path: filePath, replaced };
}

/**
 * 删除一台 server。不存在 → {removed:false}。
 * @param {string} name
 * @param {{scope?:'user'|'project', homedir?:string, cwd?:string}} [opts]
 * @returns {{path:string, removed:boolean}}
 */
function removeServer(name, opts = {}) {
  const scope = opts.scope === 'project' ? 'project' : 'user';
  const filePath = scopePath(scope, opts);
  if (!fs.existsSync(filePath)) return { path: filePath, removed: false };
  const config = readConfigFile(filePath);
  if (!Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
    return { path: filePath, removed: false };
  }
  delete config.mcpServers[name];
  _writeConfigFile(filePath, config);
  return { path: filePath, removed: true };
}

module.exports = {
  scopePath,
  readConfigFile,
  addServer,
  removeServer,
};
