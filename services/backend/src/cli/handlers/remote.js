'use strict';

/**
 * CLI handler for remote SSH commands.
 *
 * Usage:
 *   /remote hosts          — List SSH hosts from ~/.ssh/config (KHY_REMOTE_SSH_CONFIG_PATH)
 *   /remote connect <host> — Connect to a remote host (delegates to the unified remotedev facade)
 *   /remote exec <cmd>     — Plan / run a command on the active connection (dry-run unless KHY_REMOTE_SSH_ENABLE_EXEC)
 *   /remote sessions       — List active connections
 *   /remote disconnect     — Disconnect all sessions
 *
 * NOTE: previously this handler called non-existent APIs
 * (remote.sshConfig.discoverHosts / remote.connectionManager.connect /
 * remote.execService.exec / .getSessions / .disconnectAll). Those methods do not
 * exist on services/remote — every subcommand threw at runtime. This rewrite
 * binds to the real exports (sshConfigService / sshConnectionManager /
 * remoteExecService) and routes `connect` through remoteDevService so session
 * identity is recorded in the single durable pointer.
 */

async function handleRemote(input, deps) {
  const { chalk: c } = deps;
  const args = String(input || '').trim().split(/\s+/);
  const sub = (args[0] || 'hosts').toLowerCase();

  switch (sub) {
    case 'hosts':
      return _hosts(c);
    case 'connect':
      return _connect(c, args.slice(1).join(' '), deps);
    case 'exec':
      return _exec(c, args.slice(1).join(' '));
    case 'sessions':
      return _sessions(c);
    case 'disconnect':
      return _disconnect(c);
    default:
      _help(c);
  }
}

function _remote() {
  return require('../../services/remote');
}

async function _hosts(c) {
  try {
    const { configPath, hosts } = _remote().sshConfigService.listHosts();
    if (!hosts || hosts.length === 0) {
      console.log(c.yellow(`未发现 SSH 主机 (检查 ${configPath || '~/.ssh/config'})`));
      return;
    }
    console.log(c.bold(`SSH 主机 (${hosts.length})  来源: ${c.dim(configPath)}`));
    for (const h of hosts) {
      const detail = h.host ? ` → ${h.user ? h.user + '@' : ''}${h.host}:${h.port || 22}` : '';
      console.log(`  ${c.green('●')} ${h.alias}${c.dim(detail)}`);
    }
  } catch (err) {
    console.log(c.red(`获取主机列表失败: ${err.message}`));
  }
}

async function _connect(c, hostArg, deps) {
  if (!hostArg) {
    console.log(c.yellow('用法: /remote connect <host>'));
    return;
  }
  // Route through the unified facade so the durable session pointer is written
  // and the same allowlist / credential / workspace gates apply everywhere.
  const svc = require('../../services/remotedev/remoteDevService');
  const options = (deps && deps.options) || {};
  const res = await svc.connect(hostArg, { workspace: options.workspace || options.ws });
  if (!res.ok) {
    console.log(c.red(`连接失败: ${res.message}`));
    return;
  }
  const s = res.session || {};
  console.log(c.green(`✓ 已连接到 ${s.hostAlias || hostArg} (会话 ${(s.connectionId || '').slice(0, 8)} · 工作目录 ${s.remoteWorkspace || '~'})`));
  console.log(c.dim('  统一状态: khy remotedev status'));
}

async function _exec(c, command) {
  if (!command) {
    console.log(c.yellow('用法: /remote exec <command>'));
    return;
  }
  try {
    const remote = _remote();
    // Need an active connection: use the current durable session pointer.
    const pointer = require('../../services/remotedev/remoteDevSessionStore').readPointer();
    if (!pointer || !pointer.connectionId) {
      console.log(c.yellow('无活动会话。先运行 /remote connect <host> 或 /remotedev connect <host>。'));
      return;
    }
    const execEnabled = process.env.KHY_REMOTE_SSH_ENABLE_EXEC === '1'
      || process.env.KHY_REMOTE_SSH_ENABLE_EXEC === 'true';
    if (!execEnabled) {
      // Honest default: side-effecting remote exec is disabled → show the plan.
      const plan = remote.remoteExecService.planDryRun({
        connectionId: pointer.connectionId,
        commands: [command],
      });
      console.log(c.yellow('远程执行已禁用（KHY_REMOTE_SSH_ENABLE_EXEC 未开）— 仅显示计划 (dry-run):'));
      console.log(c.dim(`  主机 ${plan.host_alias} · 工作目录 ${plan.remote_workspace} · 风险 ${plan.risk_summary && plan.risk_summary.highest_risk}`));
      return;
    }
    const result = await remote.remoteExecService.requestExecution({
      connectionId: pointer.connectionId,
      commands: [command],
    });
    console.log(JSON.stringify(result && result.status ? { status: result.status } : result, null, 2));
  } catch (err) {
    try {
      require('../cliErrorReporter').reportCliError(err, { context: `远程命令: ${command}` });
    } catch {
      console.log(c.red(`执行失败: ${err.message}`));
    }
  }
}

async function _sessions(c) {
  try {
    const sessions = _remote().sshConnectionManager.listSessions();
    if (!sessions || sessions.length === 0) {
      console.log(c.dim('无活跃连接'));
      return;
    }
    console.log(c.bold(`活跃连接 (${sessions.length}):`));
    for (const s of sessions) {
      const addr = `${s.remoteUser ? s.remoteUser + '@' : ''}${s.host || ''}${s.port ? ':' + s.port : ''}`;
      console.log(`  ${c.green('●')} ${s.hostAlias || s.host || s.connectionId} ${c.dim(addr)} — ${s.status || 'connected'}`);
    }
  } catch (err) {
    console.log(c.red(`获取会话失败: ${err.message}`));
  }
}

async function _disconnect(c) {
  try {
    _remote().sshConnectionManager.clearAll();
    // Also drop the durable dev-session pointer so status reflects reality.
    try { require('../../services/remotedev/remoteDevSessionStore').clearPointer(); } catch { /* best-effort */ }
    console.log(c.green('✓ 已断开所有远程连接'));
  } catch (err) {
    console.log(c.red(`断开连接失败: ${err.message}`));
  }
}

function _help(c) {
  const lines = [
    c.bold('远程 SSH 管理'),
    '',
    `  ${c.green('hosts')}          列出 SSH 主机`,
    `  ${c.green('connect')} <host>  连接远程主机`,
    `  ${c.green('exec')} <cmd>     远程执行命令（默认 dry-run）`,
    `  ${c.green('sessions')}       查看活跃连接`,
    `  ${c.green('disconnect')}     断开所有连接`,
    '',
    c.dim('  统一入口: /remotedev (rdev) status — daemon + 会话 + bridge 一体化状态'),
  ];
  console.log(lines.join('\n'));
}

module.exports = { handleRemote };
