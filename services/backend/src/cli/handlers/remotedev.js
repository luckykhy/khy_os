'use strict';

/**
 * CLI handler for the unified remote-dev facade.
 *
 * Usage:
 *   /remotedev connect <host> [--workspace <dir>] [--purpose <p>]
 *   /remotedev attach [--id <connectionId>]
 *   /remotedev status
 *   /remotedev logs
 *   /remotedev stop [--scope session|bridge|daemon|all]
 *   /remotedev help
 *
 * Alias: /rdev. This is the single entry point that unifies daemon + remote SSH
 * session + bridge state and always prints which host / session / workspace /
 * port the current connection is using.
 */

const svc = require('../../services/remotedev/remoteDevService');
const { foldOutput } = require('../toolDisplayPolicy');

function _chalk() {
  try { return require('chalk'); } catch { /* fallthrough */ }
  const id = (s) => s;
  return new Proxy({}, { get: () => id });
}

/** @param {string} subCommand @param {string[]} args @param {object} options */
async function handleRemoteDev(subCommand, args = [], options = {}) {
  const c = _chalk();
  if (!svc.isEnabled(process.env)) {
    console.log(c.yellow('远端开发统一入口已禁用（KHY_REMOTEDEV=0）。'));
    return true;
  }
  const sub = String(subCommand || 'status').toLowerCase();

  switch (sub) {
    case 'connect': return _connect(c, args, options);
    case 'attach': return _attach(c, options);
    case 'status': return _status(c);
    case 'logs': return _logs(c);
    case 'stop': return _stop(c, options);
    case 'help':
    default: return _help(c);
  }
}

async function _connect(c, args, options) {
  const host = (Array.isArray(args) ? args : []).find((a) => a && !String(a).startsWith('-'));
  const res = await svc.connect(host, {
    workspace: options.workspace || options.ws,
    purpose: options.purpose,
  });
  if (!res.ok) {
    console.log(c.red(`✗ 连接失败：${res.message}`));
    return true;
  }
  console.log(c.green('✓ 已建立远端开发会话'));
  _printUnified(c, res.unified);
  return true;
}

async function _attach(c, options) {
  const res = await svc.attach({ connectionId: options.id || options.connectionId });
  if (!res.ok) {
    console.log(c.yellow(`未附着：${res.message}`));
    return true;
  }
  console.log(c.green('✓ 已附着到远端开发会话'));
  _printUnified(c, res.unified);
  return true;
}

async function _status(c) {
  const unified = await svc.status();
  _printUnified(c, unified);
  return true;
}

function _logs(c) {
  const { logPath, lines, error } = svc.logs();
  console.log('');
  console.log(c.dim(`  Daemon 日志：${logPath || '(不可用)'}`));
  if (error || !lines.length) {
    console.log(c.yellow('  无可读日志。'));
    console.log('');
    return true;
  }
  const { lines: folded } = foldOutput(lines, { maxLines: 30, foldHead: 0, foldTail: 30 });
  console.log('');
  for (const line of folded) console.log(`  ${c.dim(line)}`);
  console.log('');
  return true;
}

async function _stop(c, options) {
  const scope = options.scope || 'session';
  const res = await svc.stop({ scope });
  const parts = [];
  if (res.sessionCleared) parts.push('远端会话已清除');
  if (res.bridgeStopped) parts.push('bridge 已停止');
  if (res.daemonStopped) parts.push('daemon 已停止');
  console.log(c.green(`✓ 停止（scope=${res.scope}）：${parts.length ? parts.join('，') : '无活动资源'}`));
  return true;
}

const { summarizeConnection } = require('../../services/remotedev/remoteDevState');

function _printUnified(c, unified) {
  if (!unified) {
    console.log(c.yellow('  无法获取统一状态。'));
    return;
  }
  console.log('');
  // ── the one-line truth: host / session / workspace / port ──
  console.log('  ' + c.bold(summarizeConnection(unified)));
  console.log('');

  const s = unified.session || {};
  console.log(c.bold('  会话 (Remote dev session)'));
  if (s.connectionId) {
    console.log(`    状态:     ${_sessionStateLabel(c, s)}`);
    console.log(`    主机:     ${s.hostAlias || '-'}${s.host && s.host !== s.hostAlias ? c.dim(` (${s.host})`) : ''}`);
    console.log(`    地址:     ${s.remoteUser ? s.remoteUser + '@' : ''}${s.host || '-'}${s.port != null ? ':' + s.port : ''}`);
    console.log(`    工作目录: ${s.remoteWorkspace || '~'}`);
    console.log(`    会话 ID:  ${s.connectionId}`);
  } else {
    console.log(c.dim('    （无活动会话）'));
  }
  console.log('');

  const d = unified.daemon || {};
  console.log(c.bold('  Daemon'));
  if (d.running) {
    const upSec = Math.round((d.uptimeMs || 0) / 1000);
    const upStr = upSec < 60 ? `${upSec}s` : `${Math.round(upSec / 60)}m`;
    console.log(`    ${c.green('running')}  PID ${d.pid}  端口 ${d.port != null ? d.port : '-'}  运行 ${upStr}`);
  } else {
    console.log(c.dim('    not running'));
  }
  console.log('');

  const b = unified.bridge || {};
  console.log(c.bold('  Bridge'));
  if (b.running) {
    console.log(`    ${c.green('running')}  ${b.url || '-'}  PIN ${b.pin || '-'}  客户端 ${b.clientCount}`);
  } else {
    console.log(c.dim('    not running（移动端/远端附着前先 `khy bridge start`）'));
  }
  console.log('');

  const r = unified.remote || {};
  console.log(c.bold(`  远端注册表  活动会话 ${r.activeSessionCount || 0} · 待批准 ${r.pendingApprovalCount || 0}`));
  for (const sess of (r.sessions || [])) {
    const tag = (s.connectionId && sess.connectionId === s.connectionId) ? c.green(' ◀ 当前') : '';
    console.log(`    ${c.dim('•')} ${sess.hostAlias || sess.host || '?'} ${c.dim((sess.connectionId || '').slice(0, 8))}${tag}`);
  }
  console.log('');

  console.log(c.bold('  可发现配置 (Discoverable — 无硬编码)'));
  for (const row of (unified.discoverability || [])) {
    const val = row.value == null ? c.dim('(默认)') : row.value;
    console.log(`    ${row.label.padEnd(20)} ${val}  ${c.dim('$' + row.env)}`);
  }
  console.log('');
}

function _sessionStateLabel(c, s) {
  if (s.state === 'live') return c.green('活动 (live)');
  if (s.state === 'recoverable') return c.yellow('可恢复 (进程重启，元数据保留)');
  return c.dim('无');
}

function _help(c) {
  console.log('');
  console.log(c.bold('  远端开发统一入口 (remotedev / rdev)'));
  console.log('');
  console.log(c.dim('    /remotedev connect <host> [--workspace <dir>] [--purpose <p>]   建立远端开发会话'));
  console.log(c.dim('    /remotedev attach [--id <connectionId>]                         附着/确认现有会话'));
  console.log(c.dim('    /remotedev status                                               daemon+会话+bridge 统一状态'));
  console.log(c.dim('    /remotedev logs                                                 查看 daemon 最近日志'));
  console.log(c.dim('    /remotedev stop [--scope session|bridge|daemon|all]             停止（默认仅会话）'));
  console.log('');
  return true;
}

module.exports = { handleRemoteDev };
