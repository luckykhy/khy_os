'use strict';

/**
 * mcpEcosystemRegistry.js — 纯叶子:**「khy 蹭 MCP 生态」的单一声明式真源**。
 * 零 IO / 确定性 / 绝不抛。
 *
 * ## 背景(goal 2026-08-18「khyos 的生态不够完善,我希望你蹭生态」)
 *
 * MCP server 是当下 agent 生态里唯一**跨厂商通用**的工具层:同一个 `mcpServers` 映射
 * (`{command,args,env}` | `{type:'sse'|'http',url}`)被 Claude Code / Claude Desktop / Cursor /
 * Windsurf / VS Code / Codex / Gemini CLI / Kiro / Amazon Q / Zed / Cline / Roo 各自存在
 * **各自的配置文件**里。用户在任何一个 agent 里装过的 MCP server,都是 khy 可以**直接复用**的
 * 既有资产 —— 不需要重新安装、不需要自建市场。
 *
 * 但本仓在此之前只桥了 **2 个**生态,而且是两份**逐字节手写**的桥:
 *   - `ccMcpBridge.js`(Claude Code:~/.claude.json + <proj>/.mcp.json)
 *   - `ocMcpBridge.js`(OpenClaw:<stateHome>/openclaw.json 的 `mcp.servers`,JSON5)
 * 且 `services/mcp/index.js loadConfig` 里为这两家各写了一段**结构相同**的 merge 块
 * (探测→读→解析→抽 map→打 `_ccBridged`/`_ocBridged` 标记)。每接一家生态就要复制第三段。
 *
 * 本模块把「一家生态怎么被蹭」变成**一行表项**:声明配置文件在哪(base+segs)、什么格式
 * (json/json5/toml)、servers 映射在哪个键(点号路径)、条目是什么形状(shape)。壳里只留**一个
 * 通用循环**,新增生态从此不再改壳。
 *
 * ## 契约
 * - 零 IO:homedir / projectDir / platform / env 由壳注入;文件**文本**也由壳读入后传进来。
 * - 确定性:同输入同输出,表项顺序即合并顺序。
 * - 绝不抛:任何坏输入 → 安全空值([] / {} / null),让壳继续。
 * - 门控:总闸 `KHY_MCP_ECOSYSTEM`(默认开)+ 每家 `KHY_MCP_ECO_<ID>`(默认开,父为总闸)。
 *   总闸关 → `mcpEcosystemSources()` 返 `[]`,壳里那段循环整体空转,合并结果与接入前**逐字节相同**。
 *
 * ## 诚实边界(务必保留在文档里)
 * - 本模块只**发现并复用**其他 agent 已经配置好的 server;不安装、不联网、不启动任何东西
 *   (连接仍由 khy 现有 MCP client 负责)。安装依旧是各家 agent 自己的事。
 * - Claude Code 与 OpenClaw **刻意不在本表**:它们各有已上线的专用桥(含 CC 的 `projects[dir]`
 *   特殊形状与 OpenClaw 的 stateHome 覆盖链),重复登记会让同一个 server 走两条路径。
 * - 每个表项带 `evidence`:`'local'` = 本机确证过该文件存在;`'doc'` = 依据上游文档/社区约定登记,
 *   本机没有这家 agent(2026-08-18 实测:除 Claude Code 外,~/.codex、~/.cursor、~/.gemini、
 *   ~/.qwen、~/.continue、~/.aws/amazonq、~/.copilot、~/.config/zed、%APPDATA%/Claude、
 *   %APPDATA%/Code 全部不存在)。`'doc'` 项的路径**未经本机验证**;但读取是 fail-soft 的
 *   ——文件不存在就跳过,路径写错的后果是「没蹭到」,不会误伤已有配置。
 *
 * @module services/mcp/mcpEcosystemRegistry
 */

const parseTomlTables = require('../../utils/parseTomlTables');
const _join = require('../../utils/pathJoinSafe');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 未解析的交互占位符:带这些的条目 khy 连不上,登记时直接跳过(见 _hasPlaceholder)。 */
const _PLACEHOLDER_RE = /\$\{(input|command|env|userHome|workspaceFolder):?/;

/**
 * 声明式生态表。**新增一家生态 = 在这里加一行**,壳不动。
 *
 *   id           — 稳定短 id(也是 `_ecoBridged` 标记值与 CLI 展示 key)
 *   label        — 人读名字
 *   gate         — 该家的 env 门控名(默认开;父门控 KHY_MCP_ECOSYSTEM)
 *   sources[]    — 配置文件位置:
 *                    base   'home' = 用户主目录
 *                           'userAppConfig' = 平台应用配置根(win:%APPDATA% /
 *                                             darwin:~/Library/Application Support / 其他:XDG_CONFIG_HOME|~/.config)
 *                           'project' = 当前项目目录
 *                    segs   相对该 base 的路径段
 *                    kind   该 source 的稳定标识(进 CLI/诊断输出)
 *                    platforms 可选:仅在这些 process.platform 上探测
 *   format       — 'json' | 'json5' | 'toml'(如何把文本变对象)
 *   extract      — servers 映射所在的点号路径(如 'mcpServers' / 'mcp.servers' / 'mcp_servers')
 *   shape        — 条目形状:'standard' | 'vscode' | 'zed'(见 normalizeServerConfig)
 *   remoteDefault— 只给了 url 且没写 type 时,按 'http' 还是 'sse' 处理
 *   evidence     — 'local'(本机确证)| 'doc'(上游文档约定,本机无此 agent)
 */
const ECOSYSTEMS = Object.freeze(
  [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      gate: 'KHY_MCP_ECO_CLAUDE_DESKTOP',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [
        { base: 'userAppConfig', segs: ['Claude', 'claude_desktop_config.json'], kind: 'desktop' },
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      gate: 'KHY_MCP_ECO_CURSOR',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.cursor', 'mcp.json'], kind: 'user' },
        { base: 'project', segs: ['.cursor', 'mcp.json'], kind: 'project' },
      ],
    },
    {
      id: 'windsurf',
      label: 'Windsurf (Codeium)',
      gate: 'KHY_MCP_ECO_WINDSURF',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'sse',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.codeium', 'windsurf', 'mcp_config.json'], kind: 'user' },
      ],
    },
    {
      id: 'vscode',
      label: 'VS Code (Copilot agent)',
      gate: 'KHY_MCP_ECO_VSCODE',
      format: 'json',
      extract: 'servers',
      shape: 'vscode',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [
        { base: 'userAppConfig', segs: ['Code', 'User', 'mcp.json'], kind: 'user' },
        { base: 'project', segs: ['.vscode', 'mcp.json'], kind: 'project' },
      ],
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      gate: 'KHY_MCP_ECO_CODEX',
      format: 'toml',
      extract: 'mcp_servers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [{ base: 'home', segs: ['.codex', 'config.toml'], kind: 'user' }],
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      gate: 'KHY_MCP_ECO_GEMINI',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      // Gemini CLI 约定:`url` 是 SSE,`httpUrl` 是 streamable HTTP。
      remoteDefault: 'sse',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.gemini', 'settings.json'], kind: 'user' },
        { base: 'project', segs: ['.gemini', 'settings.json'], kind: 'project' },
      ],
    },
    {
      id: 'qwen',
      label: 'Qwen Code',
      gate: 'KHY_MCP_ECO_QWEN',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'sse',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.qwen', 'settings.json'], kind: 'user' },
        { base: 'project', segs: ['.qwen', 'settings.json'], kind: 'project' },
      ],
    },
    {
      id: 'kiro',
      label: 'Kiro',
      gate: 'KHY_MCP_ECO_KIRO',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.kiro', 'settings', 'mcp.json'], kind: 'user' },
        { base: 'project', segs: ['.kiro', 'settings', 'mcp.json'], kind: 'project' },
      ],
    },
    {
      id: 'amazonq',
      label: 'Amazon Q Developer CLI',
      gate: 'KHY_MCP_ECO_AMAZONQ',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.aws', 'amazonq', 'mcp.json'], kind: 'user' },
        { base: 'project', segs: ['.amazonq', 'mcp.json'], kind: 'project' },
      ],
    },
    {
      id: 'copilot-cli',
      label: 'GitHub Copilot CLI',
      gate: 'KHY_MCP_ECO_COPILOT_CLI',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [{ base: 'home', segs: ['.copilot', 'mcp-config.json'], kind: 'user' }],
    },
    {
      id: 'continue',
      label: 'Continue',
      gate: 'KHY_MCP_ECO_CONTINUE',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [{ base: 'home', segs: ['.continue', 'config.json'], kind: 'user' }],
    },
    {
      id: 'zed',
      label: 'Zed',
      gate: 'KHY_MCP_ECO_ZED',
      // Zed 的 settings.json 允许注释 → 用 JSON5 容错解析。
      format: 'json5',
      extract: 'context_servers',
      shape: 'zed',
      remoteDefault: 'http',
      evidence: 'doc',
      sources: [
        { base: 'home', segs: ['.config', 'zed', 'settings.json'], kind: 'user' },
        {
          base: 'userAppConfig',
          segs: ['Zed', 'settings.json'],
          kind: 'user-win',
          platforms: ['win32'],
        },
      ],
    },
    {
      id: 'cline',
      label: 'Cline (VS Code)',
      gate: 'KHY_MCP_ECO_CLINE',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'sse',
      evidence: 'doc',
      sources: [
        {
          base: 'userAppConfig',
          segs: [
            'Code',
            'User',
            'globalStorage',
            'saoudrizwan.claude-dev',
            'settings',
            'cline_mcp_settings.json',
          ],
          kind: 'globalStorage',
        },
      ],
    },
    {
      id: 'roo',
      label: 'Roo Code (VS Code)',
      gate: 'KHY_MCP_ECO_ROO',
      format: 'json',
      extract: 'mcpServers',
      shape: 'standard',
      remoteDefault: 'sse',
      evidence: 'doc',
      sources: [
        {
          base: 'userAppConfig',
          segs: [
            'Code',
            'User',
            'globalStorage',
            'rooveterinaryinc.roo-cline',
            'settings',
            'mcp_settings.json',
          ],
          kind: 'globalStorage',
        },
      ],
    },
  ].map((e) => Object.freeze({ ...e, sources: Object.freeze(e.sources.map((s) => Object.freeze(s))) }))
);

/** 本模块**刻意不登记**的生态及原因(文档化,避免后人重复登记)。 */
const EXCLUDED = Object.freeze({
  'claude-code': '已有专用桥 ccMcpBridge(含 projects[dir] 特殊形状)',
  openclaw: '已有专用桥 ocMcpBridge(含 stateHome 覆盖链 + JSON5)',
  warp: 'MCP 配置存在应用内部数据库,非可读 JSON 文件',
  trae: '未找到稳定的公开配置约定,不猜路径',
});

// ── 门控 ────────────────────────────────────────────────────────────────────

/** 总闸 KHY_MCP_ECOSYSTEM:默认开,{0,false,off,no} 关。优先走 flagRegistry。 */
function isMcpEcosystemEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_MCP_ECOSYSTEM', e);
    }
  } catch {
    /* 注册表不可用 → 本地兜底 */
  }
  const raw = e.KHY_MCP_ECOSYSTEM;
  return !(raw !== undefined && raw !== null && _FALSY.has(String(raw).trim().toLowerCase()));
}

/** 某家生态是否启用:总闸开 且 自身门控未被显式关闭。未知 id → false。 */
function isEcosystemEnabled(id, env = process.env) {
  try {
    if (!isMcpEcosystemEnabled(env)) {
      return false;
    }
    const eco = ECOSYSTEMS.find((x) => x.id === String(id || '').trim());
    if (!eco) {
      return false;
    }
    const e = env || {};
    try {
      const reg = require('../flagRegistry');
      if (
        reg &&
        typeof reg.isRegistryEnabled === 'function' &&
        reg.isRegistryEnabled(e) &&
        typeof reg.isFlagEnabled === 'function'
      ) {
        return reg.isFlagEnabled(eco.gate, e);
      }
    } catch {
      /* 兜底 */
    }
    const raw = e[eco.gate];
    return !(raw !== undefined && raw !== null && _FALSY.has(String(raw).trim().toLowerCase()));
  } catch {
    return false;
  }
}

/** 当前启用的生态表项(总闸关 → [])。 */
function getEcosystems(env = process.env) {
  try {
    if (!isMcpEcosystemEnabled(env)) {
      return [];
    }
    return ECOSYSTEMS.filter((e) => isEcosystemEnabled(e.id, env));
  } catch {
    return [];
  }
}

// ── 路径解析 ────────────────────────────────────────────────────────────────

/**
 * 解析平台应用配置根:win → %APPDATA%,darwin → ~/Library/Application Support,
 * 其他 → $XDG_CONFIG_HOME || ~/.config。无法解析 → ''。
 */
function userAppConfigDir({ homedir, platform, env } = {}) {
  try {
    const e = env || {};
    const plat = String(platform || '');
    if (plat === 'win32') {
      const appdata = e.APPDATA;
      if (appdata) {
        return String(appdata);
      }
      return _join(homedir, 'AppData', 'Roaming');
    }
    if (plat === 'darwin') {
      return _join(homedir, 'Library', 'Application Support');
    }
    const xdg = e.XDG_CONFIG_HOME;
    if (xdg) {
      return String(xdg);
    }
    return _join(homedir, '.config');
  } catch {
    return '';
  }
}

/** 把一个 source 的 base 解析成绝对目录;不可解析 → ''。 */
function resolveBase(base, { homedir, projectDir, platform, env } = {}) {
  switch (base) {
    case 'home':
      return homedir ? String(homedir) : '';
    case 'project':
      return projectDir ? String(projectDir) : '';
    case 'userAppConfig':
      return userAppConfigDir({ homedir, platform, env });
    default:
      return '';
  }
}

/**
 * 枚举所有启用生态的配置文件位置(**不碰文件系统** —— 壳决定哪些存在、读取文本)。
 *
 * @param {object} args
 * @param {string} args.homedir      用户主目录(壳注入 os.homedir())
 * @param {string} [args.projectDir] 当前项目目录
 * @param {string} [args.platform]   process.platform
 * @param {object} [args.env]        process.env
 * @returns {Array<{ecosystem:string,label:string,path:string,kind:string,format:string,extract:string,shape:string,remoteDefault:string,evidence:string}>}
 *   表项顺序 → 每项内 source 顺序(即合并顺序)。坏输入/总闸关 → []。
 */
function mcpEcosystemSources({ homedir, projectDir, platform, env = process.env } = {}) {
  try {
    const out = [];
    const seen = new Set();
    for (const eco of getEcosystems(env)) {
      for (const src of eco.sources) {
        if (Array.isArray(src.platforms) && !src.platforms.includes(String(platform || ''))) {
          continue;
        }
        const dir = resolveBase(src.base, { homedir, projectDir, platform, env });
        if (!dir) {
          continue;
        }
        const p = _join(dir, ...src.segs);
        if (!p || seen.has(`${eco.id}::${p}`)) {
          continue;
        }
        seen.add(`${eco.id}::${p}`);
        out.push({
          ecosystem: eco.id,
          label: eco.label,
          path: p,
          kind: src.kind,
          format: eco.format,
          extract: eco.extract,
          shape: eco.shape,
          remoteDefault: eco.remoteDefault,
          evidence: eco.evidence,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── 解析与抽取 ──────────────────────────────────────────────────────────────

/** JSON5 容错解析(优先仓库依赖,否则剥注释/尾逗号后走 JSON.parse)。 */
function _parseJson5(text) {
  try {
    const JSON5 = require('json5');
    if (JSON5 && typeof JSON5.parse === 'function') {
      return JSON5.parse(text);
    }
  } catch {
    /* 依赖不可用 → 手工降级 */
  }
  try {
    const stripped = String(text)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * 把某个 source 的文本解析成对象。
 * @param {string} text 文件内容(壳注入)
 * @param {string} format 'json' | 'json5' | 'toml'
 * @returns {object|null} 失败 → null(壳跳过该 source)
 */
function parseEcosystemConfig(text, format) {
  try {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }
    if (format === 'toml') {
      return parseTomlTables(text);
    }
    if (format === 'json5') {
      return _parseJson5(text);
    }
    try {
      return JSON.parse(text);
    } catch {
      // 生态里的 settings.json 常带注释(VS Code / Zed 系)→ 退到 JSON5 再试一次。
      return _parseJson5(text);
    }
  } catch {
    return null;
  }
}

/** 沿点号路径取值;缺失/非对象 → null。 */
function _pick(obj, dotted) {
  try {
    let node = obj;
    for (const seg of String(dotted || '').split('.')) {
      if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, seg)) {
        return null;
      }
      node = node[seg];
    }
    return node && typeof node === 'object' ? node : null;
  } catch {
    return null;
  }
}

/** 条目里是否含未解析占位符(`${input:...}` 等)→ khy 连不上,跳过。 */
function _hasPlaceholder(value) {
  try {
    if (typeof value === 'string') {
      return _PLACEHOLDER_RE.test(value);
    }
    if (Array.isArray(value)) {
      return value.some(_hasPlaceholder);
    }
    if (value && typeof value === 'object') {
      return Object.values(value).some(_hasPlaceholder);
    }
    return false;
  } catch {
    return false;
  }
}

/** 只保留字符串值的 env 映射(khy spawn 需要字符串)。空 → undefined。 */
function _cleanEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return undefined;
  }
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** 归一 transport 名 → khy 的 'stdio' | 'sse' | 'http'。未知 → ''。 */
function _normType(t) {
  const v = String(t || '')
    .trim()
    .toLowerCase();
  if (!v) {
    return '';
  }
  if (v === 'stdio' || v === 'local' || v === 'command') {
    return 'stdio';
  }
  if (v === 'sse') {
    return 'sse';
  }
  if (
    v === 'http' ||
    v === 'https' ||
    v === 'streamable-http' ||
    v === 'streamablehttp' ||
    v === 'http-stream' ||
    v === 'remote'
  ) {
    return 'http';
  }
  return '';
}

/**
 * 把一家生态的单个 server 条目归一到 khy 的 MCP 配置形状:
 *   `{type:'stdio', command, args?, env?}` 或 `{type:'sse'|'http', url, headers?}`
 *
 * @param {object} cfg 生态里的原始条目
 * @param {object} opts
 * @param {string} [opts.shape] 'standard' | 'vscode' | 'zed'
 * @param {string} [opts.remoteDefault] 只有 url 且没写 type 时按 'http' 还是 'sse'
 * @returns {object|null} 归一后的配置;不可用(禁用/占位符/缺字段/extension 型)→ null
 */
function normalizeServerConfig(cfg, { shape = 'standard', remoteDefault = 'http' } = {}) {
  try {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return null;
    }
    // 各生态通用的「已禁用」标记(Cline / Roo / Cursor 都用过)。
    if (cfg.disabled === true || cfg.enabled === false) {
      return null;
    }
    if (_hasPlaceholder(cfg)) {
      return null;
    }

    let command = cfg.command;
    let args = cfg.args;
    let env = cfg.env;

    if (shape === 'zed') {
      // Zed:`{command:{path,args,env}}`(新版也有扁平 command 字符串);
      // `{source:'extension'}` 由扩展自己拉起,khy 无法复用 → 跳过。
      if (command && typeof command === 'object' && !Array.isArray(command)) {
        args = command.args !== undefined ? command.args : args;
        env = command.env !== undefined ? command.env : env;
        command = command.path || command.command;
      }
      if (!command && cfg.source && String(cfg.source).toLowerCase() !== 'custom') {
        return null;
      }
    }

    // command 写成数组(`["npx","-y","pkg"]`)→ 首项是命令,其余并入 args 前面。
    if (Array.isArray(command)) {
      const list = command.map((x) => String(x)).filter(Boolean);
      if (!list.length) {
        command = undefined;
      } else {
        command = list[0];
        args = list.slice(1).concat(Array.isArray(args) ? args.map((x) => String(x)) : []);
      }
    }

    const url = cfg.url || cfg.httpUrl || cfg.serverUrl || cfg.endpoint;
    const declared = _normType(cfg.type || cfg.transport || cfg.transportType);

    // stdio:有可执行命令即可。
    if (command && typeof command === 'string' && declared !== 'sse' && declared !== 'http') {
      const out = { type: 'stdio', command: String(command) };
      if (Array.isArray(args) && args.length) {
        out.args = args.map((x) => String(x));
      }
      const cleanEnv = _cleanEnv(env);
      if (cleanEnv) {
        out.env = cleanEnv;
      }
      if (cfg.cwd && typeof cfg.cwd === 'string') {
        out.cwd = cfg.cwd;
      }
      return out;
    }

    // 远端:必须有 http(s) URL。
    if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      // 显式 type 优先;否则 httpUrl → http,裸 url → 该生态的 remoteDefault。
      let type = declared === 'sse' || declared === 'http' ? declared : '';
      if (!type) {
        type = cfg.httpUrl ? 'http' : _normType(remoteDefault) || 'http';
      }
      const out = { type, url };
      if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
        const h = _cleanEnv(cfg.headers);
        if (h) {
          out.headers = h;
        }
      }
      return out;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 从一份已解析的生态配置里抽出**归一后**的 server 映射。
 *
 * @param {object} parsed parseEcosystemConfig 的结果
 * @param {object} opts { extract, shape, remoteDefault }(来自 mcpEcosystemSources 的条目)
 * @returns {object} `{ name: khyServerConfig }`;任何缺失/坏输入 → {}
 */
function extractEcosystemServers(parsed, { extract, shape, remoteDefault } = {}) {
  try {
    const map = _pick(parsed, extract);
    if (!map || Array.isArray(map)) {
      return {};
    }
    const out = {};
    for (const [name, cfg] of Object.entries(map)) {
      if (!name || typeof name !== 'string') {
        continue;
      }
      const norm = normalizeServerConfig(cfg, { shape, remoteDefault });
      if (norm) {
        out[name] = norm;
      }
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  ECOSYSTEMS,
  EXCLUDED,
  isMcpEcosystemEnabled,
  isEcosystemEnabled,
  getEcosystems,
  userAppConfigDir,
  resolveBase,
  mcpEcosystemSources,
  parseEcosystemConfig,
  extractEcosystemServers,
  normalizeServerConfig,
};
