'use strict';

/**
 * mcpExport.js — `khy mcp export` 与 `khy mcp doctor` 的纯逻辑 + IO 层。
 *
 * export:把 khyos 的 MCP server 配置生成为各主流 agent 的格式,可选直接写入配置文件。
 * doctor: 诊断 khyos MCP server 健康状态 + 各 agent 的连接状态。
 *
 * 设计原则:
 * - 纯函数(generateAgentConfig / detectInstalledAgents)与 IO(writeAgentConfig)分离,便于单测。
 * - 绝不抛:所有 IO 操作 fail-soft,错误返回 { ok:false, reason } 而非抛异常。
 * - 只写 `--write` 模式下才动配置文件;缺省只 stdout 输出。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 纯函数:配置生成 ──────────────────────────────────────────────────────────

/**
 * 支持的 agent 及其配置文件位置(相对 home 目录或绝对路径)。
 * configKey 是该 agent MCP 配置里的 servers 映射键名。
 */
const AGENT_TARGETS = Object.freeze({
  commandcode: {
    label: 'Command Code',
    configFile: path.join(os.homedir(), '.commandcode', 'mcp.json'),
    configKey: 'mcpServers',
    format: 'standard',
  },
  claude: {
    label: 'Claude Code',
    configFile: path.join(os.homedir(), '.claude.json'),
    configKey: 'mcpServers',
    format: 'standard',
  },
  cursor: {
    label: 'Cursor',
    configFile: path.join(os.homedir(), '.cursor', 'mcp.json'),
    configKey: 'mcpServers',
    format: 'standard',
  },
  vscode: {
    label: 'VS Code',
    configFile: path.join(os.homedir(), '.vscode', 'settings.json'),
    configKey: 'mcpServers',
    format: 'vscode',
  },
  claudeDesktop: {
    label: 'Claude Desktop',
    configFile: path.join(
      process.platform === 'win32' ? (process.env.APPDATA || '') : os.homedir(),
      'Claude',
      'claude_desktop_config.json'
    ),
    configKey: 'mcpServers',
    format: 'standard',
  },
});

/**
 * 获取 khyos MCP server 的启动命令(跨平台兼容)。
 * @returns {{ command: string, args: string[] }}
 */
function _resolveKhyCommand() {
  // 优先用 khy 全局命令;fallback 到 node 直接启动
  let command = 'khy';
  let args = ['mcp', 'serve'];

  // Windows 上可能需要 .cmd 后缀
  if (process.platform === 'win32') {
    // 检查 khy.cmd 是否存在
    try {
      const { execSync } = require('child_process');
      execSync('where khy.cmd 2>nul || where khy 2>nul', { stdio: 'ignore' });
    } catch {
      // fallback: 用 node 启动 backend/bin/khy.js
      const khyJs = path.join(
        process.env.KHY_PORTABLE_ROOT || path.join(os.homedir(), 'Portable', 'khy-os'),
        'services',
        'backend',
        'bin',
        'khy.js'
      );
      if (fs.existsSync(khyJs)) {
        command = 'node';
        args = [khyJs, 'mcp', 'serve'];
      }
    }
  }

  return { command, args };
}

/**
 * 生成标准 MCP server 配置(claude/cursor/commandcode 通用格式)。
 * @param {string} serverName - 注册名(缺省 'khyos')
 * @returns {object}
 */
function _buildStandardConfig(serverName = 'khyos') {
  const { command, args } = _resolveKhyCommand();
  return {
    [serverName]: {
      transport: 'stdio',
      command,
      args,
    },
  };
}

/**
 * 生成 VS Code 格式配置(mcp 嵌套在 settings.json 里)。
 * @param {string} serverName
 * @returns {object}
 */
function _buildVSCodeConfig(serverName = 'khyos') {
  const { command, args } = _resolveKhyCommand();
  return {
    mcp: {
      servers: {
        [serverName]: {
          command,
          args,
        },
      },
    },
  };
}

/**
 * 根据 agent 类型生成完整配置文件内容。
 * @param {string} agentType - 'commandcode' | 'claude' | 'cursor' | 'vscode' | 'claudeDesktop'
 * @param {string} [serverName='khyos']
 * @returns {{ ok: true, config: object, target: object } | { ok: false, reason: string }}
 */
function generateAgentConfig(agentType, serverName = 'khyos') {
  const target = AGENT_TARGETS[String(agentType || '').toLowerCase()];
  if (!target) {
    const valid = Object.keys(AGENT_TARGETS).join(', ');
    return { ok: false, reason: `未知 agent 类型:${agentType}。可用: ${valid}` };
  }

  let config;
  if (target.format === 'vscode') {
    config = _buildVSCodeConfig(serverName);
  } else {
    config = _buildStandardConfig(serverName);
  }

  return { ok: true, config, target };
}

// ── 纯函数:检测已安装的 agent ──────────────────────────────────────────────

/**
 * 检测系统中已安装的 agent(检查配置文件目录是否存在)。
 * @returns {Array<{ id: string, label: string, configPath: string, installed: boolean }>}
 */
function detectInstalledAgents() {
  const results = [];
  for (const [id, target] of Object.entries(AGENT_TARGETS)) {
    const dir = path.dirname(target.configFile);
    let installed = false;
    try {
      installed = fs.existsSync(dir);
    } catch {
      installed = false;
    }
    results.push({
      id,
      label: target.label,
      configPath: target.configFile,
      installed,
    });
  }
  return results;
}

// ── IO:读取/写入配置文件 ───────────────────────────────────────────────────

/**
 * 安全读取 JSON 配置文件(不存在则返回空对象)。
 * @param {string} filePath
 * @returns {object}
 */
function _safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const text = fs.readFileSync(filePath, 'utf-8');
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * 安全写入 JSON 配置文件(保留原内容,只合并 mcpServers)。
 * @param {string} filePath
 * @param {object} newServers - 要合并的 servers 映射
 * @param {string} configKey - 配置键名
 * @returns {{ ok: boolean, path: string, reason?: string }}
 */
function _safeWriteJson(filePath, newServers, configKey) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const existing = _safeReadJson(filePath);
    if (!existing[configKey]) {
      existing[configKey] = {};
    }
    Object.assign(existing[configKey], newServers);
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, path: filePath, reason: e.message };
  }
}

/**
 * 写入 agent 配置文件。
 * @param {string} agentType
 * @param {object} config - generateAgentConfig 返回的 config
 * @param {object} target - generateAgentConfig 返回的 target
 * @returns {{ ok: boolean, path: string, reason?: string }}
 */
function writeAgentConfig(agentType, config, target) {
  if (!target || agentType === 'vscode') {
    // VS Code 特殊处理: mcp.servers 嵌套在 settings.json
    return _safeWriteJson(target.configFile, config.mcp.servers, 'mcp');
  }
  return _safeWriteJson(target.configFile, config, target.configKey);
}

// ── 诊断:doctor ────────────────────────────────────────────────────────────

/**
 * 检查 khyos MCP server 是否可启动。
 * @returns {{ ok: boolean, command: string, reason?: string }}
 */
function checkServeAvailability() {
  const protocol = require('../../services/domain/messaging/mcp/mcpServerProtocol.js');
  if (!protocol.isServeEnabled(process.env)) {
    return { ok: false, command: 'khy', reason: 'KHY_MCP_SERVE 未启用' };
  }
  const { command, args } = _resolveKhyCommand();
  return { ok: true, command: `${command} ${args.join(' ')}` };
}

/**
 * 列出 khyos 暴露的工具。
 * @returns {{ ok: boolean, tools: Array<{ name: string, description: string, risk: string }>, reason?: string }}
 */
function listExposedTools() {
  try {
    const policy = require('../../services/domain/messaging/mcp/mcpServeToolPolicy.js');
    const registry = require('../../tools');
    if (typeof registry.loadTools === 'function') {
      registry.loadTools();
    }
    const enabled =
      typeof registry.getEnabled === 'function' ? registry.getEnabled() : new Map();
    const arr = enabled instanceof Map ? [...enabled.values()] : Array.isArray(enabled) ? enabled : [];
    const exposed = policy.selectExposedTools(arr, policy.resolveExposeMode(process.env));
    const tools = exposed.map((t) => ({
      name: t.name,
      description: (t.description || '').slice(0, 80),
      risk: t.risk || 'medium',
      readOnly: typeof t.isReadOnly === 'function' ? !!t.isReadOnly() : false,
    }));
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], reason: e.message };
  }
}

/**
 * 检查各 agent 配置文件中是否已有 khyos 连接。
 * @returns {Array<{ agent: string, configPath: string, hasKhyos: boolean, serverName?: string }>}
 */
function checkAgentConnections() {
  const results = [];
  for (const [id, target] of Object.entries(AGENT_TARGETS)) {
    const cfg = _safeReadJson(target.configFile);
    const servers = cfg[target.configKey] || {};
    const names = Object.keys(servers);
    const khyosName = names.find((n) => n === 'khyos' || n.startsWith('khy'));
    results.push({
      agent: target.label,
      configPath: target.configFile,
      hasKhyos: !!khyosName,
      serverName: khyosName,
    });
  }
  return results;
}

module.exports = {
  AGENT_TARGETS,
  generateAgentConfig,
  detectInstalledAgents,
  writeAgentConfig,
  checkServeAvailability,
  listExposedTools,
  checkAgentConnections,
  _resolveKhyCommand,
};
