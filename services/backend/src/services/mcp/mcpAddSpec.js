'use strict';

/**
 * mcpAddSpec.js — 纯叶子:把 `khy mcp add …` 的 CLI 片段解析/校验成一台 MCP server 的配置(单一真源)。
 *
 * 定位(GOAL「khy 无生态,需适配连接外部;如 MCP 的安装」):对齐 `claude mcp add <名> … -- <命令> …`。
 * khy 早已有成熟的 MCP client/host(services/mcp/index.js:stdio via spawn、SSE、HTTP、autoConnect、
 * tool pool、`~/.khy/mcp.json` + loadConfig/saveConfig),唯一缺口是「往 mcp.json 写一台 server」的 CLI
 * 写入器。本叶子只做**无 IO 的解析+校验+构形**,真正的文件读写交给薄 IO 层 mcpConfigStore。
 *
 * khy 的命令行解析器(router.parseInput)语义:`--` 之后的所有 token 原样进 args(保留内层命令自己的
 * `-y` 等短旗标);`--key value` 进 options;单短横 `-s/-e` 不被识别为选项 → 落进 args。为兼容用户从
 * `claude mcp add filesystem -s user -e K=V -- npx …` 直接拷贝,本叶子在 rest 头部**再扫一段 flag 前导**
 * (识别 -s/--scope、-e/--env(可多次)、-t/--transport、-u/--url、-H/--header),消费掉后剩下的才是命令。
 *
 * 契约:零 IO(只读 process.env 做门控)、确定性、绝不抛(非法输入 → {ok:false,error})。
 */

const mcpTypes = require('./types');

// ── 门控(KHY_MCP_ADD,default-on,CANON off)────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * `khy mcp add/remove` 是否启用。flagRegistry 优先,注册表不可用 → 本地 CANON(4 词)回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isMcpAddEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_MCP_ADD', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_MCP_ADD;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 名称校验(对齐 tutorial 错误①:^[a-zA-Z0-9_-]{1,64}$)──────────────────────
const _NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
function isValidServerName(name) {
  return typeof name === 'string' && _NAME_RE.test(name);
}

/** 归一 scope:user(默认)/ project(local 别名)。未知 → 'user'。 */
function normalizeScope(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  if (v === 'project' || v === 'local' || v === 'proj') return 'project';
  return 'user';
}

/** 归一 transport:stdio(默认)/ sse / http。未知 → null(交调用方报错)。 */
function normalizeTransport(t) {
  const v = String(t == null ? '' : t).trim().toLowerCase();
  if (!v) return 'stdio';
  if (v === 'stdio' || v === 'sse' || v === 'http') return v;
  return null;
}

/**
 * 解析一个 `KEY=VALUE` 环境变量对(value 可含 `=`,按第一个 `=` 切)。非法 → null。
 * @param {string} pair
 * @returns {[string,string]|null}
 */
function parseEnvPair(pair) {
  const s = String(pair == null ? '' : pair).trim();
  const eq = s.indexOf('=');
  if (eq <= 0) return null;
  const key = s.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return [key, s.slice(eq + 1)];
}

/**
 * 把 `--env "K1=V1,K2=V2"` 这种(khy 双短横解析进 options 的)串拆成对象。
 * 值本身若含逗号无法在此形态表达 → 用多个 `-e` 前导(见 buildServerConfig)。
 * @param {string} str
 * @returns {object}
 */
function parseEnvString(str) {
  const out = {};
  const s = String(str == null ? '' : str);
  if (!s) return out;
  for (const part of s.split(',')) {
    const kv = parseEnvPair(part);
    if (kv) out[kv[0]] = kv[1];
  }
  return out;
}

// 前导 flag 别名 → 规范键(用于扫描 rest 头部,兼容拷贝 claude 的 -s/-e 写法)。
const _FLAG_ALIASES = {
  '-s': 'scope', '--scope': 'scope',
  '-e': 'env', '--env': 'env',
  '-t': 'transport', '--transport': 'transport',
  '-u': 'url', '--url': 'url',
  '-H': 'header', '--header': 'header',
};

/**
 * 从 rest 头部消费一段可识别的 flag 前导,返回 { flags, command } 。
 * 遇到第一个非可识别 flag 的 token(即命令)即停止;`--` 已被 khy 解析器剥掉,不会出现在这里。
 * @param {string[]} rest
 * @returns {{ scope?:string, env:object, transport?:string, url?:string, headers:object, command:string[] }}
 */
function _consumePreamble(rest) {
  const arr = Array.isArray(rest) ? rest.slice() : [];
  const flags = { env: {}, headers: {} };
  let i = 0;
  while (i < arr.length) {
    const tok = arr[i];
    const key = _FLAG_ALIASES[tok];
    if (!key) break; // 命令开始
    const val = arr[i + 1];
    if (val === undefined) { i += 1; break; } // 悬空 flag → 忽略
    if (key === 'env') {
      const kv = parseEnvPair(val);
      if (kv) flags.env[kv[0]] = kv[1];
    } else if (key === 'header') {
      const idx = String(val).indexOf(':');
      if (idx > 0) flags.headers[String(val).slice(0, idx).trim()] = String(val).slice(idx + 1).trim();
    } else {
      flags[key] = val;
    }
    i += 2;
  }
  flags.command = arr.slice(i);
  return flags;
}

/**
 * 由 CLI 片段构造一台 MCP server 的配置。
 * @param {object} input
 * @param {string} input.name - server 名(必须匹配 ^[a-zA-Z0-9_-]{1,64}$)
 * @param {string[]} input.rest - name 之后的所有 token(可含前导 flag + 命令/参数)
 * @param {object} [input.options] - khy 解析器已抽出的 `--key value`(scope/env/transport/url)
 * @returns {{ok:true, name:string, config:object, scope:string}|{ok:false, error:string}}
 */
function buildServerConfig(input = {}) {
  const name = input.name;
  if (!name) {
    return { ok: false, error: '缺少 server 名。用法:khy mcp add <名> [--scope user|project] [--env K=V] -- <命令> [参数…]' };
  }
  if (!isValidServerName(name)) {
    return { ok: false, error: `非法 server 名「${name}」:只能包含字母、数字、下划线、连字符,长度 1–64(对齐 MCP 工具名规则)。` };
  }

  const options = input.options || {};
  const pre = _consumePreamble(input.rest || []);

  // scope / transport / url:前导 flag 优先,其次 khy options。
  const scope = normalizeScope(pre.scope !== undefined ? pre.scope : options.scope);
  const transport = normalizeTransport(pre.transport !== undefined ? pre.transport
    : (options.transport !== undefined ? options.transport : undefined));
  if (transport === null) {
    return { ok: false, error: `未知传输类型「${pre.transport || options.transport}」(支持 stdio|sse|http)。` };
  }
  const url = pre.url !== undefined ? pre.url
    : (typeof options.url === 'string' ? options.url : undefined);

  // env:khy options.--env 串 + 前导 -e 对(前导覆盖同名)。
  const env = { ...parseEnvString(typeof options.env === 'string' ? options.env : ''), ...pre.env };
  const hasEnv = Object.keys(env).length > 0;
  const hasHeaders = Object.keys(pre.headers).length > 0;

  // ── 开源 MCP 预设展开(mcpServerPresets;门控 KHY_MCP_PRESETS)──────────────────
  // `khy mcp add github` / `khy mcp add filesystem ~/Documents` 免写完整命令:名字命中内置
  // 开源预设、传输为默认 stdio、且用户没有显式给出 launcher 命令时,展开成标准 stdio 配置,
  // 命令后的位置参数(如 filesystem 的目录)作为 extraArgs 追加。显式 `-- npx …`(首 token 是
  // 已知 launcher)则视为覆盖,跳过预设走原有手打命令路径。门控关 → hasPreset 恒 false → 回退。
  const _LAUNCHERS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'uv',
    'node', 'python', 'python3', 'deno', 'docker', 'sh', 'bash', 'cmd']);
  if (transport === 'stdio') {
    let presets = null;
    try { presets = require('./mcpServerPresets'); } catch { presets = null; }
    if (presets && presets.hasPreset(name, process.env)) {
      const first = pre.command.length ? String(pre.command[0]).trim().toLowerCase() : '';
      const explicitCommand = first && _LAUNCHERS.has(first);
      if (!explicitCommand) {
        let resolved;
        try {
          resolved = presets.resolvePreset(name, { extraArgs: pre.command, env, gateEnv: process.env });
        } catch { resolved = { ok: false }; }
        if (resolved && resolved.ok) {
          try {
            const v = mcpTypes.validateServerConfig(resolved.config);
            if (v && v.valid === false) {
              return { ok: false, error: `预设配置校验失败:${(v.errors || []).join('; ')}` };
            }
          } catch { /* fail-soft */ }
          return { ok: true, name: resolved.name, config: resolved.config, scope, preset: resolved.meta };
        }
      }
    }
  }

  let config;
  if (transport === 'stdio') {
    const cmd = pre.command;
    if (!cmd.length || !String(cmd[0]).trim()) {
      return { ok: false, error: '缺少要启动的命令。用法:khy mcp add <名> -- <命令> [参数…](例:-- npx -y @modelcontextprotocol/server-filesystem ~/Documents)。' };
    }
    config = { type: 'stdio', command: String(cmd[0]) };
    if (cmd.length > 1) config.args = cmd.slice(1).map(String);
    if (hasEnv) config.env = env;
  } else {
    // sse / http:需要 url。
    const u = url || (pre.command.length ? pre.command[0] : undefined);
    if (!u || !/^https?:\/\//i.test(String(u))) {
      return { ok: false, error: `${transport} 传输需要一个 http(s) URL(--url <地址>)。` };
    }
    config = { type: transport, url: String(u) };
    if (hasHeaders) config.headers = pre.headers;
    if (hasEnv) config.env = env;
  }

  // 复用既有校验器(单一真源:与 client 连接时同一份 validateServerConfig)。
  try {
    const v = mcpTypes.validateServerConfig(config);
    if (v && v.valid === false) {
      return { ok: false, error: `配置校验失败:${(v.errors || []).join('; ')}` };
    }
  } catch { /* 校验器异常 → 不阻断(fail-soft) */ }

  return { ok: true, name, config, scope };
}

module.exports = {
  isMcpAddEnabled,
  isValidServerName,
  normalizeScope,
  normalizeTransport,
  parseEnvPair,
  parseEnvString,
  buildServerConfig,
  _consumePreamble, // exposed for tests
};
