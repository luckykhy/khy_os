'use strict';

/**
 * crossPlatform.js — `khy cross` CLI: 四端跨设备同步 + 跨端启动.
 *
 * 子命令:
 *   khy cross status                     查看跨设备同步状态
 *   khy cross connect                    连接跨设备同步服务器
 *   khy cross disconnect                 断开连接
 *   khy cross devices                    列出已连接设备
 *   khy cross sessions                   列出活跃会话
 *   khy cross join <sessionId>           加入会话
 *   khy cross leave <sessionId>          离开会话
 *   khy cross send <deviceId> <message>  发送消息到指定设备
 *   khy cross notify <userId> <title>    发送通知到指定用户
 *   khy cross route <platform> <command> 路由命令到指定平台
 *   khy cross start <platform>          启动另一个平台
 *   khy cross start all                 启动所有平台
 *   khy cross stop <platform>           停止另一个平台
 *
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 */

const { printSuccess, printError, printInfo, printTable } = require('../formatters');
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { AI_BACKEND_DEFAULT_URL, BACKEND_PORT, WEB_FRONTEND_PORT, MOBILE_FRONTEND_PORT } = require('../../constants/serviceDefaults');

let _client = null;

function _getClient() {
  if (_client) return _client;
  const { createTerminalClient } = require('../../services/crossPlatform/clients/terminalClient');
  const backendUrl = process.env.KHY_BACKEND_URL || AI_BACKEND_DEFAULT_URL;
  const wsUrl = backendUrl.replace(/^http/, 'ws') + '/ws/cross-platform';
  _client = createTerminalClient({
    url: wsUrl,
    token: process.env.KHY_AUTH_TOKEN,
    autoReconnect: true,
  });
  return _client;
}

async function handleCross(subCommand, args, options = {}) {
  const sub = subCommand || 'status';

  switch (sub) {
    case 'status':
      return _handleStatus(options);
    case 'connect':
      return _handleConnect(options);
    case 'disconnect':
      return _handleDisconnect(options);
    case 'devices':
      return _handleDevices(options);
    case 'sessions':
      return _handleSessions(options);
    case 'join':
      return _handleJoin(args, options);
    case 'leave':
      return _handleLeave(args, options);
    case 'send':
      return _handleSend(args, options);
    case 'notify':
      return _handleNotify(args, options);
    case 'route':
      return _handleRoute(args, options);
    case 'start':
      return _handleStart(args, options);
    case 'stop':
      return _handleStop(args, options);
    default:
      printError(`未知子命令: ${sub}`);
      printInfo('可用子命令: status, connect, disconnect, devices, sessions, join, leave, send, notify, route, start, stop');
  }
}

function _handleStatus(options) {
  const client = _getClient();
  const state = client.state;
  const deviceId = client.deviceId;

  printInfo(`设备ID: ${deviceId}`);
  printInfo(`连接状态: ${state}`);

  // Try to connect if not connected
  if (state === 'disconnected' || state === 'error') {
    printInfo(`连接跨设备同步服务器 (${AI_BACKEND_DEFAULT_URL})...`);
    client.connect();
    // Wait briefly for auth result
    return new Promise((resolve) => {
      const onAuth = () => {
        printSuccess('连接成功!');
        client.off('authenticated', onAuth);
        client.off('auth:error', onAuthError);
        resolve();
      };
      const onAuthError = (err) => {
        printError(`认证失败: ${err}`);
        client.off('authenticated', onAuth);
        client.off('auth:error', onAuthError);
        resolve();
      };
      client.once('authenticated', onAuth);
      client.once('auth:error', onAuthError);
      setTimeout(() => {
        client.off('authenticated', onAuth);
        client.off('auth:error', onAuthError);
        resolve();
      }, 5000);
    });
  }

  if (state === 'connected') {
    printSuccess('已连接');
    client.once('device:list', (devices) => {
      if (devices && devices.length > 0) {
        printInfo(`\n已连接设备 (${devices.length}):`);
        const rows = devices.map(d => [d.deviceId, d.platform, d.deviceName || '-']);
        printTable(['设备ID', '平台', '名称'], rows);
      } else {
        printInfo('暂无其他设备连接');
      }
    });
    client.listDevices();
    return new Promise(resolve => setTimeout(resolve, 2000));
  }
}

function _handleConnect(options) {
  // Use autoConnect for persistent connection with event listeners
  const { init, getClient } = require('../autoConnect');
  const client = init();
  
  printInfo('连接中...');
  return new Promise((resolve) => {
    const onAuth = () => {
      printSuccess('连接成功!');
      client.off('authenticated', onAuth);
      client.off('auth:error', onAuthError);
      resolve();
    };
    const onAuthError = (err) => {
      printError(`连接失败: ${err}`);
      client.off('authenticated', onAuth);
      client.off('auth:error', onAuthError);
      resolve();
    };
    client.once('authenticated', onAuth);
    client.once('auth:error', onAuthError);
    setTimeout(() => {
      client.off('authenticated', onAuth);
      client.off('auth:error', onAuthError);
      resolve();
    }, 5000);
  });
}

function _handleDisconnect(options) {
  const client = _getClient();
  client.disconnect();
  printSuccess('已断开连接');
}

function _handleDevices(options) {
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    return;
  }
  client.listDevices();
  return new Promise((resolve) => {
    client.once('device:list', (devices) => {
      if (!devices || devices.length === 0) {
        printInfo('暂无设备');
      } else {
        printInfo(`设备列表 (${devices.length}):`);
        const rows = devices.map(d => [d.deviceId, d.platform, d.deviceName || '-']);
        printTable(['设备ID', '平台', '名称'], rows);
      }
      resolve();
    });
    setTimeout(resolve, 2000);
  });
}

function _handleSessions(options) {
  const { hub } = require('../../services/crossPlatform/crossPlatformHub');
  const status = hub.getStatus();
  printInfo(`活跃会话数: ${status.totalSessions}`);
  if (hub._sessions && hub._sessions.size > 0) {
    const rows = [];
    for (const [id, s] of hub._sessions) {
      rows.push([id, s.version, new Date(s.lastModified).toLocaleTimeString()]);
    }
    printTable(['会话ID', '版本', '最后修改'], rows);
  }
}

function _handleJoin(args, options) {
  const sessionId = args[0];
  if (!sessionId) {
    printError('用法: khy cross join <sessionId>');
    return;
  }
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    return;
  }
  client.joinSession(sessionId);
  printSuccess(`已加入会话: ${sessionId}`);
}

function _handleLeave(args, options) {
  const sessionId = args[0];
  if (!sessionId) {
    printError('用法: khy cross leave <sessionId>');
    return;
  }
  const client = _getClient();
  client.leaveSession(sessionId);
  printSuccess(`已离开会话: ${sessionId}`);
}

function _handleSend(args, options) {
  const targetDeviceId = args[0];
  const message = args.slice(1).join(' ');
  if (!targetDeviceId || !message) {
    printError('用法: khy cross send <deviceId> <message>');
    return;
  }
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    return;
  }
  client.sendMessage({ targetDeviceId, payload: { text: message } });
  printSuccess(`消息已发送到 ${targetDeviceId}`);
}

function _handleNotify(args, options) {
  const userId = args[0];
  const title = args[1];
  const body = args.slice(2).join(' ');
  if (!userId || !title) {
    printError('用法: khy cross notify <userId> <title> [body]');
    return;
  }
  const syncServer = require('../../services/crossPlatform/ws/syncServer');
  syncServer.notifyUser(userId, title, body);
  printSuccess(`通知已发送到用户 ${userId}`);
}

function _handleRoute(args, options) {
  const targetPlatform = args[0];
  const command = args[1];
  if (!targetPlatform || !command) {
    printError('用法: khy cross route <platform> <command>');
    return;
  }
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    return;
  }
  client.routeCommand(targetPlatform, command, {});
  printSuccess(`命令已路由到 ${targetPlatform}`);
}

function _handleStart(args, options) {
  const { startPlatform, startMultiple } = require('../../services/crossPlatform/crossLauncher');
  const target = args[0];
  
  if (!target) {
    printError('用法: khy cross start <platform|all>');
    printInfo('可用平台: backend, cli, web, desktop, mobile, all');
    return;
  }

  if (target === 'all') {
    printInfo('正在启动所有平台...');
    return startMultiple(['backend', 'web', 'desktop']).then(results => {
      results.forEach(r => {
        if (r.success) {
          printSuccess(`✓ ${r.platform} 已启动 (PID: ${r.pid})`);
        } else {
          printError(`✗ ${r.platform} 启动失败: ${r.error}`);
        }
      });
    });
  }

  printInfo(`正在启动 ${target}...`);
  return startPlatform(target).then(result => {
    if (result.success) {
      printSuccess(`${target} 已启动 (PID: ${result.pid})`);
    } else {
      printError(`${target} 启动失败: ${result.error}`);
    }
  });
}

function _handleStop(args, options) {
  const target = args[0];
  if (!target) {
    printError('用法: khy cross stop <platform>');
    return;
  }

  // Use taskkill to stop by port or process name
  const { execSync } = require('child_process');
  const portMap = { backend: BACKEND_PORT, web: WEB_FRONTEND_PORT, mobile: MOBILE_FRONTEND_PORT };
  const port = portMap[target];
  
  if (!port) {
    printError(`未知平台: ${target}`);
    return;
  }

  try {
    const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
    const lines = output.split('\n').filter(l => l.includes('LISTENING'));
    if (lines.length === 0) {
      printInfo(`${target} (端口 ${port}) 未在运行`);
      return;
    }
    const pid = lines[0].trim().split(/\s+/).pop();
    execSync(`taskkill /PID ${pid} /F`);
    printSuccess(`${target} (PID: ${pid}) 已停止`);
  } catch (err) {
    printError(`停止失败: ${err.message}`);
  }
}

module.exports = {
  handleCross,
  [MANIFEST_EXPORT_KEY]: {
    name: 'cross-platform',
    aliases: ['cross', 'sync-devices'],
    description: '跨设备同步 + 跨端启动（四端：CLI/TUI/移动端/桌面端）',
    usage: 'cross-platform <status|connect|disconnect|devices|...>',
    category: 'system',
    handler: async (parsed) => handleCross(parsed.subCommand, parsed.args, parsed.options),
  },
};
