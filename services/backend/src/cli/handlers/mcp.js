'use strict';

/**
 * MCP Command Handler — `khy mcp add` / `khy mcp remove`(对齐 `claude mcp add`)。
 *
 * khy 早有成熟的 MCP client/host(services/mcp:stdio/SSE/HTTP、autoConnect、tool pool、`~/.khy/mcp.json`),
 * 本 handler 补上「把一台外部 MCP server 写进配置」的 CLI 入口 + 单台管理(show/test/enable/disable)。
 * 只读状态/governance 视图仍在 router 的 `case 'mcp'` 里;这里只处理增删改查。
 *
 *   mcp add <名> [--scope user|project] [--env K=V] [--transport sse|http --url <地址>] -- <命令> [参数…]
 *   mcp remove <名> [--scope user|project]
 *   mcp presets                                   # 列出内置开源 server 预设
 *   mcp show <名>                                 # 查看单台 server 配置详情
 *   mcp test <名>                                 # 连接并验证一台已配置 server
 *   mcp enable|disable <名> [--scope user|project] # 启用/禁用(不删除配置)
 *
 * 解析/校验/构形在纯叶子 mcpAddSpec(单一真源);文件读改写在薄 IO 层 mcpConfigStore。
 *
 * @module handlers/mcp
 */

const { printInfo, printError, printSuccess } = require('../formatters');

function _spec() {
  return require('../../services/domain/messaging/mcp/mcpAddSpec.js');
}

function _store() {
  return require('../../services/domain/messaging/mcp/mcpConfigStore.js');
}

function _presets() {
  return require('../../services/domain/messaging/mcp/mcpServerPresets.js');
}

/**
 * `khy mcp eco` —— 只读:khy 从**别家 agent 生态**蹭到了哪些 MCP server。
 *
 * 逐家扫 mcpEcosystemRegistry 声明的配置文件:存在吗、解析出几台、哪些真被采用(名字未被
 * khy 自己或 CC 桥占用)、哪些被同名遮蔽。纯只读(不写任何配置、不连接任何 server),
 * 因此不受 KHY_MCP_ADD 约束;门控在 KHY_MCP_ECOSYSTEM。
 *
 * @returns {number} 0
 */
function _handleEco() {
  const fs = require('fs');
  const os = require('os');
  let reg;
  try {
    reg = require('../../services/domain/messaging/mcp/mcpEcosystemRegistry.js');
  } catch (e) {
    printError(`生态注册表不可用:${(e && e.message) || e}`);
    return 1;
  }
  if (!reg.isMcpEcosystemEnabled(process.env)) {
    printError('MCP 生态桥未启用(KHY_MCP_ECOSYSTEM 已关闭)。开启后 khy 会复用别家 agent 已配置的 MCP server。');
    return 1;
  }

  // khy 自己(+ CC/OpenClaw 专用桥)已经占用的名字 → 生态里的同名条目会被遮蔽。
  const taken = new Set();
  try {
    const loaded = require('../../services/mcp').loadConfig(process.cwd());
    for (const [name, cfg] of Object.entries((loaded && loaded.mcpServers) || {})) {
      if (!cfg || !cfg._ecoBridged) {
        taken.add(name);
      }
    }
  } catch {
    /* 读不到就只报生态侧发现,不影响本视图 */
  }

  const sources = reg.mcpEcosystemSources({
    homedir: os.homedir(),
    projectDir: process.cwd(),
    platform: process.platform,
    env: process.env,
  });

  // 按生态聚合
  const byEco = new Map();
  for (const src of sources) {
    if (!byEco.has(src.ecosystem)) {
      byEco.set(src.ecosystem, { label: src.label, evidence: src.evidence, files: [] });
    }
    let exists = false;
    let servers = {};
    let broken = false;
    try {
      exists = fs.existsSync(src.path);
      if (exists) {
        const parsed = reg.parseEcosystemConfig(fs.readFileSync(src.path, 'utf-8'), src.format);
        if (!parsed) {
          broken = true;
        } else {
          servers = reg.extractEcosystemServers(parsed, src);
        }
      }
    } catch {
      broken = true;
    }
    byEco.get(src.ecosystem).files.push({ src, exists, broken, servers });
  }

  printInfo('MCP 生态桥(只读复用别家 agent 已配置的 server;不安装、不联网、不改别家配置)');
  printInfo('');
  let adopted = 0;
  let shadowed = 0;
  let present = 0;
  for (const [id, eco] of byEco) {
    const hit = eco.files.filter((f) => f.exists);
    if (hit.length) {
      present += 1;
    }
    const total = eco.files.reduce((n, f) => n + Object.keys(f.servers).length, 0);
    const head = hit.length
      ? total
        ? `✅ ${eco.label}(${id}):${total} 台`
        : `➖ ${eco.label}(${id}):有配置文件,未解析出可用 server`
      : `·  ${eco.label}(${id}):未安装/无配置`;
    printInfo(head);
    for (const f of eco.files) {
      if (!f.exists) {
        continue;
      }
      if (f.broken) {
        printInfo(`     ⚠ ${f.src.path}(${f.src.format} 解析失败,已跳过)`);
        continue;
      }
      printInfo(`     ${f.src.kind}: ${f.src.path}`);
      for (const [name, cfg] of Object.entries(f.servers)) {
        const where = cfg.type === 'stdio' ? cfg.command : cfg.url;
        if (taken.has(name)) {
          shadowed += 1;
          printInfo(`       - ${name} (${cfg.type}) → 同名已存在,被遮蔽`);
        } else {
          adopted += 1;
          printInfo(`       + ${name} (${cfg.type}: ${where})`);
        }
      }
    }
  }
  printInfo('');
  printSuccess(
    `共扫描 ${byEco.size} 家生态:${present} 家有配置,采用 ${adopted} 台,${shadowed} 台因同名被遮蔽。`
  );
  printInfo('生态项按上游文档约定登记(evidence=doc);文件不存在即跳过,不会误伤已有配置。');
  printInfo('关掉某一家:KHY_MCP_ECO_<ID>=0;整体关闭:KHY_MCP_ECOSYSTEM=0。`khy mcp` 看连接状态。');
  return 0;
}

function _handleAdd(args, options) {
  const spec = _spec();
  const name = Array.isArray(args) ? args[0] : undefined;
  const rest = Array.isArray(args) ? args.slice(1) : [];
  const built = spec.buildServerConfig({ name, rest, options: options || {} });
  if (!built.ok) {
    printError(built.error);
    printInfo(
      '例:khy mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~/Documents'
    );
    return 1;
  }
  let res;
  try {
    res = _store().addServer(built.name, built.config, { scope: built.scope });
  } catch (e) {
    printError(`写入 MCP 配置失败:${(e && e.message) || e}`);
    return 1;
  }
  const scopeLabel = built.scope === 'project' ? '项目级' : '用户级';
  printSuccess(
    `✅ 已${res.replaced ? '更新' : '添加'} MCP server「${built.name}」(${scopeLabel})。`
  );
  printInfo(`配置写入:${res.path}`);
  const cfg = built.config;
  if (cfg.type === 'stdio') {
    printInfo(`  启动命令:${cfg.command}${cfg.args ? ` ${cfg.args.join(' ')}` : ''}`);
  } else {
    printInfo(`  ${cfg.type} 端点:${cfg.url}`);
  }
  if (cfg.env) {
    printInfo(`  环境变量:${Object.keys(cfg.env).join(', ')}`);
  }
  // 预设展开时提示缺失的敏感 env(server 已写入,但不配 token 连不上)。
  if (built.preset) {
    if (built.preset.description) {
      printInfo(`  预设:${built.preset.description}`);
    }
    const missing = Array.isArray(built.preset.missingEnv) ? built.preset.missingEnv : [];
    if (missing.length) {
      printInfo(`  ⚠ 该预设需要环境变量:${missing.join(', ')}。`);
      printInfo(`    重新运行并追加,例:khy mcp add ${built.name} --env ${missing[0]}=<你的值>`);
    }
    if (built.preset.argHint) {
      printInfo(`  提示:${built.preset.argHint}`);
    }
  }
  printInfo('下次启动 khy 会话时会自动连接(autoConnect);`khy mcp` 查看状态。');
  return 0;
}

/**
 * `khy mcp presets` — 列出内置的开源 MCP server 预设(发现入口)。
 * @returns {number}
 */
function _handlePresets() {
  const presets = _presets();
  const list = presets.listPresets(process.env);
  if (!list.length) {
    printInfo('MCP 预设未启用(KHY_MCP_PRESETS 已关闭),或暂无可用预设。');
    return 0;
  }
  printInfo(`内置开源 MCP server 预设(${list.length} 个)。用 \`khy mcp add <名>\` 一键安装:`);
  for (const p of list) {
    const envHint =
      p.requiresEnv && p.requiresEnv.length ? `  [需 env: ${p.requiresEnv.join(', ')}]` : '';
    printInfo(`  • ${p.name} — ${p.description}${envHint}`);
    if (p.argHint) {
      printInfo(`      ${p.argHint}`);
    }
  }
  printInfo('例:khy mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=<token>');
  return 0;
}

/**
 * `khy mcp serve` — 让 khy 作为一台 MCP server 对外暴露自己的原生工具(stdio + HTTP/SSE)。
 *
 * 门控 KHY_MCP_SERVE(独立于 KHY_MCP_ADD)。stdio 分支进入常驻循环后**绝不能**再走 formatters/
 * 正常 CLI 收尾打印(会污染专供 JSON-RPC 的 stdout)——故门控/参数报错都在进入循环**之前**用 stderr
 * 或(HTTP 分支)formatters。
 *
 *   khy mcp serve [--transport stdio|http] [--host <h>] [--port <p>] [--token <t>] [--expose all|safe|readonly]
 *
 * @param {string[]} args
 * @param {object} options
 * @returns {number}
 */
function _handleServe(args, options) {
  const protocol = require('../../services/domain/messaging/mcp/mcpServerProtocol.js');
  if (!protocol.isServeEnabled(process.env)) {
    printError(
      '`khy mcp serve` 未启用(KHY_MCP_SERVE 已关闭)。开启后 khy 可作为 MCP server 对外暴露工具。'
    );
    return 1;
  }
  const opts = options || {};
  const transport = String(opts.transport || 'stdio').toLowerCase();
  const expose = opts.expose ? String(opts.expose).toLowerCase() : undefined;
  // 暴露模式经 env 传给策略叶子(尊重用户 --expose;缺省 all)。
  if (expose) {
    process.env.KHY_MCP_SERVE_EXPOSE = expose;
  }

  let version = '0.0.0';
  try {
    version = require('../../../package.json').version || version;
  } catch {
    /* 读不到 → 兜底 */
  }

  if (transport === 'http' || transport === 'sse') {
    const httpServer = require('../../services/domain/messaging/mcp/mcpHttpServer.js');
    const res = httpServer.startHttpServer({
      version,
      host: opts.host,
      port: opts.port ? Number(opts.port) : undefined,
      token: opts.token,
    });
    if (!res.ok) {
      // canStartOnHost 已在 stderr 明示原因;这里给 CLI 用户一条 formatters 提示。
      printError(res.reason || 'HTTP MCP server 启动失败。');
      return 1;
    }
    // 常驻:进程随 http.Server 存活。
    return 0;
  }

  // 缺省 stdio:进入常驻循环,stdout 专供 JSON-RPC,诊断全走 stderr。
  const stdioServer = require('../../services/domain/messaging/mcp/mcpStdioServer.js');
  stdioServer.startStdioServer({ version });
  return 0;
}

function _handleRemove(args, options) {
  const name = Array.isArray(args) ? args[0] : undefined;
  if (!name) {
    printError('用法:khy mcp remove <名> [--scope user|project]');
    return 1;
  }
  const spec = _spec();
  const scope = spec.normalizeScope(options && options.scope);
  let res;
  try {
    res = _store().removeServer(String(name), { scope });
  } catch (e) {
    printError(`删除失败:${(e && e.message) || e}`);
    return 1;
  }
  if (!res.removed) {
    printInfo(
      `${scope === 'project' ? '项目级' : '用户级'}配置里没有名为「${name}」的 MCP server(${res.path})。`
    );
    return 0;
  }
  printSuccess(`✅ 已删除 MCP server「${name}」(${scope === 'project' ? '项目级' : '用户级'})。`);
  printInfo(`配置更新:${res.path}`);
  return 0;
}

/**
 * `khy mcp show <名>` — 查看单台已配置 server 的详情(来源/传输/状态/命令或端点/环境变量键)。
 * 纯只读;读 loadConfig(合并 user/project/legacy 后的单一事实)。
 * @param {string} name
 * @returns {number}
 */
function _handleShow(name) {
  if (!name) {
    printError('用法:khy mcp show <名>');
    return 1;
  }
  let mcp, gov;
  try {
    mcp = require('../../services/mcp');
    gov = require('../../services/domain/messaging/mcp/mcpGovernance.js');
  } catch (e) {
    printError(`MCP 服务读取失败:${(e && e.message) || e}`);
    return 1;
  }
  const cfg =
    typeof mcp.loadConfig === 'function' ? mcp.loadConfig(process.cwd()) : { mcpServers: {} };
  const entry = (cfg.mcpServers || {})[name];
  if (!entry) {
    printInfo(`配置里没有名为「${name}」的 MCP server。`);
    return 0;
  }
  const scope = gov.classifyServerScope(entry);
  const connected = (
    typeof mcp.getConnectedServers === 'function' ? mcp.getConnectedServers() : []
  ).includes(name);
  const tools = (typeof mcp.listMCPTools === 'function' ? mcp.listMCPTools() : []).filter(
    (t) => t && (t.serverName === name || t.normalizedServerName === name)
  );
  const envKeys = entry.env && typeof entry.env === 'object' ? Object.keys(entry.env) : [];
  printInfo(`MCP server「${name}」:`);
  printInfo(`  来源: ${scope.scopeLabel}`);
  printInfo(`  传输: ${scope.transport}`);
  printInfo(`  状态: ${scope.disabled ? '已禁用' : connected ? '已连接' : '未连接'}`);
  printInfo(`  工具: ${tools.length} 个`);
  if (entry.command) {
    printInfo(
      `  启动命令: ${entry.command}${Array.isArray(entry.args) && entry.args.length ? ` ${entry.args.join(' ')}` : ''}`
    );
  }
  if (entry.url) {
    printInfo(`  端点: ${entry.url}`);
  }
  if (envKeys.length) {
    printInfo(`  环境变量: ${envKeys.join(', ')}`);
  }
  if (scope.configPath) {
    printInfo(`  配置文件: ${scope.configPath}`);
  }
  return 0;
}

/**
 * `khy mcp test <名>` — 连接并验证一台已配置 server,报告暴露工具数。
 * 只读 + 主动连接(不写配置);连接成功会留在连接表里(autoConnect 之外的按需连通),供后续调用。
 * @param {string} name
 * @returns {number}
 */
async function _handleTest(name) {
  if (!name) {
    printError('用法:khy mcp test <名>');
    return 1;
  }
  let mcp;
  try {
    mcp = require('../../services/mcp');
  } catch (e) {
    printError(`MCP 服务读取失败:${(e && e.message) || e}`);
    return 1;
  }
  const cfg =
    typeof mcp.loadConfig === 'function' ? mcp.loadConfig(process.cwd()) : { mcpServers: {} };
  const entry = (cfg.mcpServers || {})[name];
  if (!entry) {
    printError(`配置里没有名为「${name}」的 MCP server。`);
    return 1;
  }
  if (entry._disabled) {
    printInfo(`「${name}」已禁用,先 khy mcp enable ${name}。`);
    return 1;
  }
  const already = (
    typeof mcp.getConnectedServers === 'function' ? mcp.getConnectedServers() : []
  ).includes(name);
  // 剥离内部注解字段(_scope/_configPath/_disabled)再交给 connectMCPServer 校验。
  const { _scope, _configPath, _disabled, ...clean } = entry;
  try {
    if (!already) {
      printInfo(`正在连接「${name}」...`);
      await mcp.connectMCPServer(name, clean);
    }
    const client = typeof mcp.getClient === 'function' ? mcp.getClient(name) : null;
    const tools = client && typeof client.listTools === 'function' ? client.listTools() : [];
    printSuccess(`✅ MCP server「${name}」连接成功,暴露 ${tools.length} 个工具。`);
    return 0;
  } catch (e) {
    printError(`MCP server「${name}」连接失败:${(e && e.message) || e}`);
    return 1;
  }
}

/**
 * `khy mcp enable|disable <名>` — 启用/禁用一台 server(不删除配置)。
 * @param {string[]} args
 * @param {object} options
 * @param {boolean} enabled
 * @returns {number}
 */
function _handleSetEnabled(args, options, enabled) {
  const name = Array.isArray(args) ? args[0] : undefined;
  const action = enabled ? '启用' : '禁用';
  if (!name) {
    printError(`用法:khy mcp ${enabled ? 'enable' : 'disable'} <名> [--scope user|project]`);
    return 1;
  }
  const spec = _spec();
  const scope = spec.normalizeScope(options && options.scope);
  let res;
  try {
    res = _store().setServerEnabled(String(name), enabled, { scope });
  } catch (e) {
    printError(`写入 MCP 配置失败:${(e && e.message) || e}`);
    return 1;
  }
  if (!res.found) {
    printInfo(
      `${scope === 'project' ? '项目级' : '用户级'}配置里没有名为「${name}」的 MCP server(${res.path})。`
    );
    return 0;
  }
  printSuccess(
    `✅ 已${action} MCP server「${name}」(${scope === 'project' ? '项目级' : '用户级'})。`
  );
  printInfo(`配置更新:${res.path}`);
  printInfo(
    enabled
      ? '下次启动 khy 会话时会自动连接(autoConnect);`khy mcp` 查看状态。'
      : '禁用后不会自动连接;`khy mcp` 查看状态。'
  );
  return 0;
}

/**
 * `khy mcp export [--agent <type>] [--write]` — 生成各 agent 的 MCP 配置。
 * @param {string[]} args
 * @param {object} options
 * @returns {number}
 */
function _handleExport(args, options) {
  const exp = require('./mcpExport');
  const opts = options || {};
  const agent = opts.agent ? String(opts.agent).toLowerCase() : 'auto';
  const write = opts.write === true || opts.write === 'true' || opts.write === '1';

  // 列出已安装的 agent
  const installed = exp.detectInstalledAgents();
  const installedIds = installed.filter((a) => a.installed).map((a) => a.id);

  if (agent === 'auto') {
    // 检测所有已安装的 agent,逐个输出
    if (installedIds.length === 0) {
      printInfo('未检测到已安装的 agent。可用 --agent 指定类型(commandcode / claude / cursor / vscode / claudeDesktop)。');
      return 0;
    }
    printInfo(`已检测到 ${installedIds.length} 个 agent:${installedIds.join(', ')}`);
    printInfo('');
    let anyWritten = false;
    for (const id of installedIds) {
      const result = exp.generateAgentConfig(id);
      if (!result.ok) {
        printError(result.reason);
        continue;
      }
      printInfo(`── ${result.target.label} ──`);
      printInfo(JSON.stringify(result.config, null, 2));
      if (write) {
        const wr = exp.writeAgentConfig(id, result.config, result.target);
        if (wr.ok) {
          printSuccess(`  ✅ 已写入 ${wr.path}`);
          anyWritten = true;
        } else {
          printError(`  ❌ 写入失败: ${wr.reason}`);
        }
      }
      printInfo('');
    }
    if (!write) {
      printInfo('提示: 加 --write 可自动写入上述配置文件。');
    }
    return 0;
  }

  // 指定了特定 agent
  const validIds = Object.keys(exp.AGENT_TARGETS);
  if (!validIds.includes(agent)) {
    printError(`未知 agent 类型:${agent}。可用: ${validIds.join(', ')}`);
    return 1;
  }

  const result = exp.generateAgentConfig(agent);
  if (!result.ok) {
    printError(result.reason);
    return 1;
  }

  printInfo(JSON.stringify(result.config, null, 2));

  if (write) {
    const wr = exp.writeAgentConfig(agent, result.config, result.target);
    if (wr.ok) {
      printSuccess(`✅ 已写入 ${wr.path}`);
    } else {
      printError(`写入失败: ${wr.reason}`);
      return 1;
    }
  } else {
    printInfo('');
    printInfo(`提示: 加 --write 可写入 ${result.target.configFile}`);
  }
  return 0;
}

/**
 * `khy mcp doctor` — 诊断 khyos MCP server 健康状态。
 * @param {string[]} args
 * @param {object} options
 * @returns {number}
 */
function _handleDoctor(args, options) {
  const exp = require('./mcpExport');
  printInfo('── khyos MCP Server 诊断 ──');
  printInfo('');

  // 1. serve 可用性
  const serve = exp.checkServeAvailability();
  if (serve.ok) {
    printSuccess(`✅ MCP serve 可用: ${serve.command}`);
  } else {
    printError(`❌ MCP serve 不可用: ${serve.reason}`);
  }
  printInfo('');

  // 2. 暴露工具
  const tools = exp.listExposedTools();
  if (tools.ok) {
    printInfo(`暴露工具数: ${tools.tools.length}`);
    const byRisk = {};
    for (const t of tools.tools) {
      byRisk[t.risk] = (byRisk[t.risk] || 0) + 1;
    }
    printInfo(`  风险分布: ${Object.entries(byRisk).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    const readOnly = tools.tools.filter((t) => t.readOnly).length;
    printInfo(`  只读工具: ${readOnly}/${tools.tools.length}`);
  } else {
    printError(`❌ 枚举工具失败: ${tools.reason}`);
  }
  printInfo('');

  // 3. agent 连接状态
  printInfo('── Agent 连接状态 ──');
  const connections = exp.checkAgentConnections();
  for (const c of connections) {
    if (c.hasKhyos) {
      printSuccess(`✅ ${c.agent}: 已连接(${c.serverName})`);
    } else {
      printInfo(`  ${c.agent}: 未配置`);
    }
  }
  printInfo('');
  printInfo('修复: 运行 `khy mcp export --agent auto --write` 一键配置所有 agent。');
  return 0;
}

/**
 * @param {string} subCommand - 'add' | 'remove' | 'rm' | 'presets' | 'serve' | 'export' | 'doctor' | 'show' | 'test' | 'enable' | 'disable'
 * @param {string[]} args
 * @param {object} options
 * @returns {number} exit-ish code (0 ok)
 */
async function handleMcp(subCommand, args = [], options = {}) {
  const sub = String(subCommand || '').toLowerCase();
  // `presets` 是只读发现入口,门控在 KHY_MCP_PRESETS(不受 KHY_MCP_ADD 约束)。
  if (sub === 'presets' || sub === 'preset') {
    return _handlePresets();
  }
  // `serve` 让 khy 作为 MCP server,门控在 KHY_MCP_SERVE(不受 KHY_MCP_ADD 约束)。
  if (sub === 'serve') {
    return _handleServe(args, options);
  }
  // `export` 生成各 agent 的 MCP 配置,不受 KHY_MCP_ADD 约束。
  if (sub === 'export') {
    return _handleExport(args, options);
  }
  // `doctor` 诊断 khyos MCP server 健康状态,不受 KHY_MCP_ADD 约束。
  if (sub === 'doctor' || sub === 'diag') {
    return _handleDoctor(args, options);
  }
  // `show` 只读详情,`test` 连接验证——均不写配置,不受 KHY_MCP_ADD 约束。
  if (sub === 'show') {
    return _handleShow(Array.isArray(args) ? args[0] : undefined);
  }
  if (sub === 'test') {
    return _handleTest(Array.isArray(args) ? args[0] : undefined);
  }
  // `eco` 只读:列出从别家 agent 生态蹭到的 server,门控在 KHY_MCP_ECOSYSTEM。
  if (sub === 'eco' || sub === 'ecosystem' || sub === '生态') {
    return _handleEco();
  }
  const spec = _spec();
  if (!spec.isMcpAddEnabled(process.env)) {
    printError(
      '`khy mcp add/remove/enable/disable` 未启用(KHY_MCP_ADD 已关闭)。开启后可从命令行管理外部 MCP server。'
    );
    return 1;
  }
  if (sub === 'add') {
    return _handleAdd(args, options);
  }
  if (sub === 'remove' || sub === 'rm') {
    return _handleRemove(args, options);
  }
  if (sub === 'enable') {
    return _handleSetEnabled(args, options, true);
  }
  if (sub === 'disable') {
    return _handleSetEnabled(args, options, false);
  }
  printError(
    `未知 mcp 子命令:${subCommand}。可用:add / remove / presets / serve / export / doctor / show / test / enable / disable / eco。`
  );
  return 1;
}

module.exports = { handleMcp };
