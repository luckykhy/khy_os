'use strict';

/**
 * mcpServerPresets.js — 纯叶子:一张常用**开源 MCP server** 的预设注册表(单一真源)。
 *
 * 定位(GOAL「完善 khyos 的…开源仓库 MCP 工具」):`khy mcp add` 早能把任意 server 写进
 * `mcp.json`,但用户必须手打完整启动命令(`-- npx -y @modelcontextprotocol/server-github`),
 * 且没有「有哪些现成的可以装」的发现入口。本叶子补上短名 → 标准启动配置的映射,让
 *   khy mcp add github          # 免写命令,展开成官方 GitHub MCP server
 *   khy mcp add filesystem ~/Documents
 *   khy mcp presets             # 列出全部可用预设
 * 成为可能。真正写文件仍走 mcpConfigStore;本叶子只做**无 IO 的查表 + 构形**。
 *
 * 契约:零 IO(只读 process.env 做门控)、确定性、绝不抛(未知名 → {ok:false})。
 * 门控 KHY_MCP_PRESETS(default-on、CANON);关 → hasPreset 恒 false、resolvePreset 恒
 * {ok:false} → 上游 buildServerConfig 不做预设展开,逐字节回退「必须手打命令」。
 */

// ── 门控(KHY_MCP_PRESETS,default-on,CANON off)──────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 预设是否启用。flagRegistry 优先,注册表不可用 → 本地 CANON(4 词)回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPresetsEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_MCP_PRESETS', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_MCP_PRESETS;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 预设表 ──────────────────────────────────────────────────────────────────
// 每条:
//   command / args   → stdio 启动命令(全部走 npx/uvx 免全局安装)。
//   requiresEnv[]    → 该 server 需要的敏感环境变量(未提供也能写入,handler 会提示)。
//   argHint          → 若可接位置参数(如 filesystem 的路径),给出提示文案;null=不接。
//   description      → 一句中文说明(`khy mcp presets` 列表用)。
//   homepage         → 上游仓库/文档(信息用,不参与构形)。
// 说明:仅收录**开源、无需注册专有服务**即可跑起来的常用 server;需要 API key 的
// (github/gitlab/brave/slack)仍收录,但通过 requiresEnv 明确告知。
const _PRESETS = Object.freeze({
  github: {
    description: 'GitHub 仓库/Issue/PR 读写(开源仓库工具首选)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    requiresEnv: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  gitlab: {
    description: 'GitLab 项目/Issue/MR 读写',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    requiresEnv: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
  },
  git: {
    description: '本地 Git 仓库操作(status/diff/log/commit)',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    requiresEnv: [],
    argHint: '可追加 --repository <本地仓库路径>',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
  },
  filesystem: {
    description: '受限目录内的文件读写',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    requiresEnv: [],
    argHint: '需追加一个或多个允许访问的目录路径(例:khy mcp add filesystem ~/Documents)',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  fetch: {
    description: '抓取网页并转成适合模型阅读的 Markdown',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    requiresEnv: [],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  memory: {
    description: '基于知识图谱的持久记忆',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    requiresEnv: [],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  'sequential-thinking': {
    description: '结构化分步推理工具',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequentialthinking'],
    requiresEnv: [],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  everything: {
    description: '官方参考/测试 server(覆盖全部 MCP 能力,用于验证连通)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    requiresEnv: [],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },
  puppeteer: {
    description: '无头浏览器自动化(截图/点击/抓取)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    requiresEnv: [],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  'brave-search': {
    description: 'Brave 联网搜索',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiresEnv: ['BRAVE_API_KEY'],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  slack: {
    description: 'Slack 频道/消息读写',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    requiresEnv: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  postgres: {
    description: 'PostgreSQL 只读查询',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    requiresEnv: [],
    argHint: '需追加连接串(例:khy mcp add postgres postgresql://localhost/mydb)',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  sqlite: {
    description: 'SQLite 数据库查询',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    requiresEnv: [],
    argHint: '需追加 --db-path <数据库文件>',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  time: {
    description: '时区换算与当前时间',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    requiresEnv: [],
    argHint: null,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
});

// 短名别名 → 规范预设名。
const _ALIASES = Object.freeze({
  gh: 'github',
  fs: 'filesystem',
  file: 'filesystem',
  files: 'filesystem',
  'seq-thinking': 'sequential-thinking',
  sequentialthinking: 'sequential-thinking',
  brave: 'brave-search',
  bravesearch: 'brave-search',
  pg: 'postgres',
  postgresql: 'postgres',
});

/** 归一预设名(小写 + 别名解析)。非法输入 → ''。 */
function canonicalPresetName(name) {
  const v = String(name == null ? '' : name).trim().toLowerCase();
  if (!v) return '';
  if (Object.prototype.hasOwnProperty.call(_PRESETS, v)) return v;
  if (Object.prototype.hasOwnProperty.call(_ALIASES, v)) return _ALIASES[v];
  return '';
}

/**
 * 名字是否对应一个已知预设(受门控约束)。门控关 → 恒 false(上游不做预设展开)。
 * @param {string} name
 * @param {object} [env]
 * @returns {boolean}
 */
function hasPreset(name, env = process.env) {
  if (!isPresetsEnabled(env)) return false;
  return canonicalPresetName(name) !== '';
}

/**
 * 把一个预设名解析成标准 stdio server 配置(与 mcpAddSpec.buildServerConfig 输出同形)。
 *
 * @param {string} name - 预设名或别名
 * @param {object} [opts]
 * @param {string[]} [opts.extraArgs] - 追加到预设命令末尾的位置参数(如 filesystem 的目录路径)
 * @param {object} [opts.env] - 追加到 server 的环境变量(与预设无关,原样透传)
 * @param {object} [opts.gateEnv] - 门控用的 env(默认 process.env)
 * @returns {{ok:true, name:string, config:object, meta:object}|{ok:false, error:string}}
 */
function resolvePreset(name, opts = {}) {
  const gateEnv = opts.gateEnv || process.env;
  if (!isPresetsEnabled(gateEnv)) {
    return { ok: false, error: 'MCP 预设未启用(KHY_MCP_PRESETS 已关闭)。' };
  }
  const canon = canonicalPresetName(name);
  if (!canon) {
    return { ok: false, error: `未知 MCP 预设「${name}」。用 \`khy mcp presets\` 查看全部可用预设。` };
  }
  const p = _PRESETS[canon];
  const extra = Array.isArray(opts.extraArgs) ? opts.extraArgs.map(String).filter((s) => s !== '') : [];
  const args = p.args.slice();
  for (const a of extra) args.push(a);

  const config = { type: 'stdio', command: p.command };
  if (args.length) config.args = args;
  const env = (opts.env && typeof opts.env === 'object') ? opts.env : null;
  if (env && Object.keys(env).length) config.env = { ...env };

  // 未提供预设声明所需的敏感 env → 收集缺项供 handler 提示(不阻断:server 仍写入)。
  const providedEnvKeys = new Set(env ? Object.keys(env) : []);
  const missingEnv = (p.requiresEnv || []).filter((k) => !providedEnvKeys.has(k));

  return {
    ok: true,
    name: canon,
    config,
    meta: {
      canonicalName: canon,
      description: p.description,
      requiresEnv: (p.requiresEnv || []).slice(),
      missingEnv,
      argHint: p.argHint || null,
      homepage: p.homepage,
    },
  };
}

/**
 * 列出全部预设(供 `khy mcp presets` 发现入口)。门控关 → 空数组。
 * @param {object} [env]
 * @returns {Array<{name:string, description:string, command:string, requiresEnv:string[], argHint:(string|null)}>}
 */
function listPresets(env = process.env) {
  if (!isPresetsEnabled(env)) return [];
  return Object.keys(_PRESETS).sort().map((name) => {
    const p = _PRESETS[name];
    return {
      name,
      description: p.description,
      command: `${p.command} ${p.args.join(' ')}`.trim(),
      requiresEnv: (p.requiresEnv || []).slice(),
      argHint: p.argHint || null,
      homepage: p.homepage,
    };
  });
}

module.exports = {
  isPresetsEnabled,
  canonicalPresetName,
  hasPreset,
  resolvePreset,
  listPresets,
  _PRESETS, // exposed for tests
  _ALIASES, // exposed for tests
};
