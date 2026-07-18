'use strict';

/**
 * mcpGovernance.js — 纯叶子:把 MCP 的「加载关系 / 审批关系 / 优先级关系」讲清并固化为单一真源。
 *
 * 背景(先核实再动手,诚实记录现状):
 *   - 加载关系:MCP 服务器配置住在**专用的 mcp.json 文件**里,不在 settings.json 的四层模型里。
 *     loadConfig(services/mcp/index.js)按顺序读:user(~/.khy/mcp.json) → legacy(~/.khyquant/mcp.json)
 *     → project(<cwd>/.khy/mcp.json) → project-legacy(<cwd>/.khyquant/mcp.json),**后读覆盖先读**,
 *     故同名服务器 project 覆盖 user 覆盖 legacy。这与 khySettings 的 user<project<managed 四层是
 *     **两套独立体系**(一个治 settings.json,一个治 mcp.json)——本叶子把这一区别显式讲清,避免误解。
 *   - 审批关系:MCP 工具的注解 readOnlyHint/destructiveHint 在 serializeTool(types.js)被映射成
 *     isReadOnly/isDestructive 两个布尔;此后与原生工具**走同一套权限层**(toolCalling._resolveToolBehavior):
 *     plan 模式只放行 isReadOnly===true 的工具;isDestructive(不可逆)触发不可绕过的人闸门(KHY_HUMAN_GATE);
 *     无任何注解 → 既非只读也非破坏 → 走常规权限流程(默认需批准,不自动放行)。
 *   - 优先级关系:见加载关系(project > user > legacy);连接期 connectAll 跳过 _disabled 的服务器。
 *
 * 契约:零 IO、确定性(不依赖时钟/随机)、绝不抛(fail-soft)。所有路径/状态由 caller 注入,
 * 本叶子只做纯描述与纯分类,IO(读 mcp.json、查连接表)归 services/mcp/index.js 编排壳。
 */

// 相对 require(叶子→叶子,leaf-contract 放行):复用 ConfigScope 常量,避免另造字符串。
const { ConfigScope } = require('./types');

/**
 * 描述 MCP 配置的加载/优先级关系(单一真源)。路径由 caller 注入以保持纯函数。
 *
 * @param {object} [paths]
 * @param {string} [paths.userPath]      ~/.khy/mcp.json
 * @param {string} [paths.legacyPath]    ~/.khyquant/mcp.json
 * @param {string} [paths.projectDir]    当前项目目录(决定 project 层路径;缺省=无项目层)
 * @returns {Array<{order:number, scope:string, label:string, path:(string|null), overrides:(string|null), note:string}>}
 *   按**实际读取顺序**(低优先 → 高优先)。后读覆盖先读 → 列表末尾优先级最高。
 */
function describeConfigPrecedence(paths = {}) {
  const rows = [];
  const p = paths && typeof paths === 'object' ? paths : {};
  let order = 0;
  const push = (scope, label, file, overrides, note) => {
    rows.push({ order: order++, scope, label, path: file || null, overrides: overrides || null, note });
  };
  push(ConfigScope.USER, '用户级', p.userPath || null, null, '~/.khy/mcp.json(全局默认)');
  push(ConfigScope.USER, '用户级(legacy)', p.legacyPath || null, '用户级', '~/.khyquant/mcp.json(向后兼容)');
  if (p.projectDir) {
    const sep = String(p.projectDir).endsWith('/') ? '' : '/';
    push(ConfigScope.LOCAL, '项目级', `${p.projectDir}${sep}.khy/mcp.json`, '用户级', '项目共享配置,覆盖同名用户级服务器');
    push(ConfigScope.LOCAL, '项目级(legacy)', `${p.projectDir}${sep}.khyquant/mcp.json`, '项目级', '向后兼容');
  }
  return rows;
}

/**
 * 从一个已加载的服务器配置(loadConfig 标了 _scope/_disabled/_configPath)分类其来源与启用态。
 * @param {object} serverConfig
 * @returns {{scope:string, scopeLabel:string, disabled:boolean, configPath:(string|null), transport:string}}
 */
function classifyServerScope(serverConfig) {
  const cfg = serverConfig && typeof serverConfig === 'object' ? serverConfig : {};
  const scope = typeof cfg._scope === 'string' ? cfg._scope : ConfigScope.USER;
  const labelByScope = {
    [ConfigScope.USER]: '用户级',
    [ConfigScope.LOCAL]: '项目级',
    [ConfigScope.DYNAMIC]: '运行时',
  };
  return {
    scope,
    scopeLabel: labelByScope[scope] || scope,
    disabled: cfg._disabled === true,
    configPath: typeof cfg._configPath === 'string' ? cfg._configPath : null,
    transport: typeof cfg.type === 'string' && cfg.type.trim() ? cfg.type.trim() : 'stdio',
  };
}

/**
 * 把一个工具的 isReadOnly/isDestructive 映射成审批策略(与原生工具同一套权限语义,固化为单一真源)。
 * 这描述的是**已固化在权限层的真实行为**,不是新策略:
 *   - isDestructive(不可逆) → 人闸门(KHY_HUMAN_GATE,不可被 bypass/yolo 绕过)。
 *   - isReadOnly         → plan 模式可放行(只读工具在 plan 模式存活)。
 *   - 二者皆无           → 常规权限流程(默认需批准,非自动放行;plan 模式下不放行)。
 *
 * @param {{isReadOnly?:boolean, isDestructive?:boolean}} tool
 * @returns {{humanGate:boolean, planModeAllowed:boolean, autoApprovable:boolean, level:string, reason:string}}
 */
function resolveApprovalPolicy(tool) {
  const t = tool && typeof tool === 'object' ? tool : {};
  const isDestructive = t.isDestructive === true;
  const isReadOnly = t.isReadOnly === true;
  if (isDestructive) {
    return {
      humanGate: true, planModeAllowed: false, autoApprovable: false, level: 'destructive',
      reason: '破坏性(destructiveHint)→ 不可绕过的人闸门确认',
    };
  }
  if (isReadOnly) {
    return {
      humanGate: false, planModeAllowed: true, autoApprovable: true, level: 'read-only',
      reason: '只读(readOnlyHint)→ plan 模式可放行,可自动批准',
    };
  }
  return {
    humanGate: false, planModeAllowed: false, autoApprovable: false, level: 'standard',
    reason: '无注解 → 常规权限流程(默认需批准,plan 模式不放行)',
  };
}

/**
 * 聚合一个可渲染的治理视图:每个服务器的来源/启用/连接/工具数 + 审批分布 + 优先级解释。
 * 全部输入由 caller 注入(已 loadConfig 的 mcpServers + 连接名单 + 序列化工具),本叶子零 IO。
 *
 * @param {object} args
 * @param {object} [args.mcpServers]     loadConfig().mcpServers
 * @param {string[]} [args.connected]    已连接服务器名
 * @param {object[]} [args.tools]        listMCPTools() 的序列化工具(含 serverName/isReadOnly/isDestructive)
 * @param {object} [args.paths]          describeConfigPrecedence 的路径
 * @returns {object}
 */
function buildGovernanceView(args = {}) {
  const mcpServers = args.mcpServers && typeof args.mcpServers === 'object' ? args.mcpServers : {};
  const connected = new Set(Array.isArray(args.connected) ? args.connected : []);
  const tools = Array.isArray(args.tools) ? args.tools : [];

  const toolsByServer = new Map();
  const approval = { destructive: 0, readOnly: 0, standard: 0 };
  for (const tool of tools) {
    const server = tool && (tool.serverName || tool.normalizedServerName);
    if (!toolsByServer.has(server)) toolsByServer.set(server, 0);
    toolsByServer.set(server, toolsByServer.get(server) + 1);
    const pol = resolveApprovalPolicy(tool);
    if (pol.level === 'destructive') approval.destructive += 1;
    else if (pol.level === 'read-only') approval.readOnly += 1;
    else approval.standard += 1;
  }

  const servers = Object.entries(mcpServers).map(([name, cfg]) => {
    const scope = classifyServerScope(cfg);
    return {
      name,
      scope: scope.scope,
      scopeLabel: scope.scopeLabel,
      transport: scope.transport,
      disabled: scope.disabled,
      connected: connected.has(name),
      configPath: scope.configPath,
      toolCount: toolsByServer.get(name) || 0,
    };
  });

  return {
    servers,
    precedence: describeConfigPrecedence(args.paths || {}),
    approval,
    counts: {
      configured: servers.length,
      connected: servers.filter((s) => s.connected).length,
      disabled: servers.filter((s) => s.disabled).length,
      tools: tools.length,
    },
  };
}

/** 人类可读摘要行(给 `khy mcp` / 帮助 / 文档)。 */
function summarizeGovernance(view) {
  const v = view && typeof view === 'object' ? view : {};
  const c = v.counts || {};
  const a = v.approval || {};
  return [
    `MCP 治理:配置 ${c.configured || 0} · 已连接 ${c.connected || 0} · 禁用 ${c.disabled || 0} · 工具 ${c.tools || 0}`,
    `审批分布:破坏性 ${a.destructive || 0}(人闸门) · 只读 ${a.readOnly || 0}(plan 可放行) · 标准 ${a.standard || 0}(需批准)`,
    '加载优先级:项目级 > 用户级 > legacy(mcp.json 专用文件,独立于 settings.json 四层)',
  ];
}

module.exports = {
  describeConfigPrecedence,
  classifyServerScope,
  resolveApprovalPolicy,
  buildGovernanceView,
  summarizeGovernance,
};
