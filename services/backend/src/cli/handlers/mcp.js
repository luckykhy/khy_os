'use strict';

/**
 * MCP Command Handler — `khy mcp add` / `khy mcp remove`(对齐 `claude mcp add`)。
 *
 * khy 早有成熟的 MCP client/host(services/mcp:stdio/SSE/HTTP、autoConnect、tool pool、`~/.khy/mcp.json`),
 * 本 handler 补上「把一台外部 MCP server 写进配置」的 CLI 入口。只读状态/governance 视图仍在 router 的
 * `case 'mcp'` 里;这里只处理增删。
 *
 *   mcp add <名> [--scope user|project] [--env K=V] [--transport sse|http --url <地址>] -- <命令> [参数…]
 *   mcp remove <名> [--scope user|project]
 *
 * 解析/校验/构形在纯叶子 mcpAddSpec(单一真源);文件读改写在薄 IO 层 mcpConfigStore。
 *
 * @module handlers/mcp
 */

const { printInfo, printError, printSuccess } = require('../formatters');

function _spec() { return require('../../services/mcp/mcpAddSpec'); }
function _store() { return require('../../services/mcp/mcpConfigStore'); }
function _presets() { return require('../../services/mcp/mcpServerPresets'); }

function _handleAdd(args, options) {
  const spec = _spec();
  const name = Array.isArray(args) ? args[0] : undefined;
  const rest = Array.isArray(args) ? args.slice(1) : [];
  const built = spec.buildServerConfig({ name, rest, options: options || {} });
  if (!built.ok) {
    printError(built.error);
    printInfo('例:khy mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem ~/Documents');
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
  printSuccess(`✅ 已${res.replaced ? '更新' : '添加'} MCP server「${built.name}」(${scopeLabel})。`);
  printInfo(`配置写入:${res.path}`);
  const cfg = built.config;
  if (cfg.type === 'stdio') {
    printInfo(`  启动命令:${cfg.command}${cfg.args ? ` ${cfg.args.join(' ')}` : ''}`);
  } else {
    printInfo(`  ${cfg.type} 端点:${cfg.url}`);
  }
  if (cfg.env) printInfo(`  环境变量:${Object.keys(cfg.env).join(', ')}`);
  // 预设展开时提示缺失的敏感 env(server 已写入,但不配 token 连不上)。
  if (built.preset) {
    if (built.preset.description) printInfo(`  预设:${built.preset.description}`);
    const missing = Array.isArray(built.preset.missingEnv) ? built.preset.missingEnv : [];
    if (missing.length) {
      printInfo(`  ⚠ 该预设需要环境变量:${missing.join(', ')}。`);
      printInfo(`    重新运行并追加,例:khy mcp add ${built.name} --env ${missing[0]}=<你的值>`);
    }
    if (built.preset.argHint) printInfo(`  提示:${built.preset.argHint}`);
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
    const envHint = p.requiresEnv && p.requiresEnv.length ? `  [需 env: ${p.requiresEnv.join(', ')}]` : '';
    printInfo(`  • ${p.name} — ${p.description}${envHint}`);
    if (p.argHint) printInfo(`      ${p.argHint}`);
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
  const protocol = require('../../services/mcp/mcpServerProtocol');
  if (!protocol.isServeEnabled(process.env)) {
    printError('`khy mcp serve` 未启用(KHY_MCP_SERVE 已关闭)。开启后 khy 可作为 MCP server 对外暴露工具。');
    return 1;
  }
  const opts = options || {};
  const transport = String(opts.transport || 'stdio').toLowerCase();
  const expose = opts.expose ? String(opts.expose).toLowerCase() : undefined;
  // 暴露模式经 env 传给策略叶子(尊重用户 --expose;缺省 all)。
  if (expose) process.env.KHY_MCP_SERVE_EXPOSE = expose;

  let version = '0.0.0';
  try { version = require('../../../package.json').version || version; } catch { /* 读不到 → 兜底 */ }

  if (transport === 'http' || transport === 'sse') {
    const httpServer = require('../../services/mcp/mcpHttpServer');
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
  const stdioServer = require('../../services/mcp/mcpStdioServer');
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
    printInfo(`${scope === 'project' ? '项目级' : '用户级'}配置里没有名为「${name}」的 MCP server(${res.path})。`);
    return 0;
  }
  printSuccess(`✅ 已删除 MCP server「${name}」(${scope === 'project' ? '项目级' : '用户级'})。`);
  printInfo(`配置更新:${res.path}`);
  return 0;
}

/**
 * @param {string} subCommand - 'add' | 'remove' | 'rm' | 'presets'
 * @param {string[]} args
 * @param {object} options
 * @returns {number} exit-ish code (0 ok)
 */
function handleMcp(subCommand, args = [], options = {}) {
  const sub = String(subCommand || '').toLowerCase();
  // `presets` 是只读发现入口,门控在 KHY_MCP_PRESETS(不受 KHY_MCP_ADD 约束)。
  if (sub === 'presets' || sub === 'preset') return _handlePresets();
  // `serve` 让 khy 作为 MCP server,门控在 KHY_MCP_SERVE(不受 KHY_MCP_ADD 约束)。
  if (sub === 'serve') return _handleServe(args, options);
  const spec = _spec();
  if (!spec.isMcpAddEnabled(process.env)) {
    printError('`khy mcp add/remove` 未启用(KHY_MCP_ADD 已关闭)。开启后可从命令行安装外部 MCP server。');
    return 1;
  }
  if (sub === 'add') return _handleAdd(args, options);
  if (sub === 'remove' || sub === 'rm') return _handleRemove(args, options);
  printError(`未知 mcp 子命令:${subCommand}。可用:add / remove / presets / serve。`);
  return 1;
}

module.exports = { handleMcp };
