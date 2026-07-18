'use strict';

/**
 * Mesh Command Handler — `khy mesh …`(对齐 Claude Code 的多实例协作)。
 *
 * 同机上多个独立运行的 khy 实例彼此发现、attach/detach、跨进程互发消息。
 * 在册表落 ~/.khyos/peers/(每实例一份 presence + 一份信箱);存活判定 = process.kill。
 * 校验/信封/排版在纯叶子 meshCore(单一真源);磁盘 IO 在 meshStore。本 handler 只 IO/打印。
 *
 *   mesh [peers|list]               — 列出在线实例(自动剪除已退出的)
 *   mesh register [--name N] [--id I]— 把一个实例登记进网格(打印其 id)
 *   mesh send <对端id> <消息> [--from I] — 给某实例信箱投递一条消息
 *   mesh inbox <id>                 — 抽空(读取并清空)某实例的信箱
 *   mesh attach <自身id> <对端id>     — 把自身挂接到某对端(设默认对端)
 *   mesh detach <自身id>             — 解除挂接
 *   mesh on | off                   — 开/关网格能力(持久化 KHY_MESH)
 *
 * @module handlers/mesh
 */

const { printInfo, printError, printTable, printSuccess } = require('../formatters');

function _store() { return require('../../services/meshStore'); }
function _core() { return require('../../services/meshCore'); }

function _persist(value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ KHY_MESH: value });
}

function _handlePeers() {
  const peers = _store().listPeers();
  if (!peers.length) {
    printInfo('当前没有在线的 khy 实例。一个运行中的会话首次用 MeshPeer 工具或 `khy mesh register` 即会上线。');
    return 0;
  }
  const core = _core();
  const labeled = typeof core.peerLabelsEnabled === 'function' && core.peerLabelsEnabled(process.env);
  if (labeled) {
    // 会话区分:「会话」列(同目录多窗口带 #编号)+「目录」列(跨目录一眼分清)。
    const rows = peers.map((p) => [
      p.label || p.name || '-',
      p.cwd || '-',
      p.id,
      String(p.pid),
      p.attachedTo || '-',
      String(p.inbox),
      p.startedAt || '-',
    ]);
    printTable(['会话', '目录', '实例 id', 'PID', '挂接到', '待读', '上线于'], rows);
    printInfo(`共 ${peers.length} 个在线实例。同目录多窗口看「会话」列的 #编号,跨目录看「目录」列。投递:khy mesh send <实例id> <消息>`);
    return 0;
  }
  const rows = peers.map((p) => [
    p.id,
    p.name || '-',
    String(p.pid),
    p.attachedTo || '-',
    String(p.inbox),
    p.startedAt || '-',
  ]);
  printTable(['实例 id', '名称', 'PID', '挂接到', '待读', '上线于'], rows);
  printInfo(`共 ${peers.length} 个在线实例。投递消息:khy mesh send <实例id> <消息>`);
  return 0;
}

function _handleRegister(args, options) {
  const id = options && (options.id || options.i);
  const name = options && (options.name || options.n);
  const res = _store().register({
    id: id ? String(id) : undefined,
    name: name ? String(name) : (Array.isArray(args) ? args.join(' ') : undefined),
  });
  if (!res.ok) {
    printError(`登记失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 已登记实例「${res.id}」(PID ${res.record.pid})。`);
  printInfo('其它实例现在可用 `khy mesh peers` 看到它,并 `khy mesh send` 投递消息。');
  return 0;
}

function _handleSend(args, options) {
  const list = Array.isArray(args) ? args.slice() : [];
  const to = list.shift();
  const message = list.join(' ');
  if (!to || !message) {
    printError('用法:khy mesh send <对端实例id> <消息> [--from <自身id>]');
    return 1;
  }
  const from = (options && (options.from || options.f)) ? String(options.from || options.f) : 'cli';
  const res = _store().send(from, to, message);
  if (!res.ok) {
    printError(`发送失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ ${_core().buildSendSummary(res)}`);
  return 0;
}

function _handleInbox(args) {
  const id = Array.isArray(args) ? args[0] : args;
  if (!id) {
    printError('用法:khy mesh inbox <实例id>');
    return 1;
  }
  const res = _store().drainInbox(id);
  if (!res.ok) {
    printError(`读取失败:${res.error || '未知错误'}`);
    return 1;
  }
  const messages = res.messages || [];
  if (!messages.length) {
    printInfo(`实例「${id}」的信箱为空。`);
    return 0;
  }
  const rows = messages.map((m) => [m.from, m.text.length > 60 ? `${m.text.slice(0, 60)}…` : m.text]);
  printTable(['来自', '消息'], rows);
  printInfo(`已读取并清空 ${messages.length} 条消息。`);
  return 0;
}

function _handleAttach(args) {
  const list = Array.isArray(args) ? args : [];
  const self = list[0];
  const to = list[1];
  if (!self || !to) {
    printError('用法:khy mesh attach <自身id> <对端id>');
    return 1;
  }
  const res = _store().attach(self, to);
  if (!res.ok) {
    printError(`挂接失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 实例「${self}」已挂接到「${to}」。`);
  return 0;
}

function _handleDetach(args) {
  const self = Array.isArray(args) ? args[0] : args;
  if (!self) {
    printError('用法:khy mesh detach <自身id>');
    return 1;
  }
  const res = _store().detach(self);
  if (!res.ok) {
    printError(`解除失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 实例「${self}」已解除挂接。`);
  return 0;
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist(value, deps);
    printSuccess(`✅ 多实例协作网格${turnOn ? '已开启' : '已关闭'}（KHY_MESH=${value}）。已即时生效并持久化。`);
    printInfo(`已写入:${p}`);
    return 0;
  } catch (e) {
    printError(`无法持久化:${(e && e.message) || e}`);
    return 1;
  }
}

/**
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @param {object} [deps] - { writeEnvPatch } 可注入便于测试
 * @returns {number}
 */
function handleMesh(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'peers').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo('用法: mesh [peers] | mesh register [--name N] | mesh send <对端id> <消息> [--from I] | mesh inbox <id> | mesh attach <自身id> <对端id> | mesh detach <自身id> | mesh on | mesh off');
    printInfo('同机多个 khy 实例互相发现并跨进程通信。与单进程内 teammate/coordinator、跨机 remote 互不相干。');
    return 0;
  }
  if (!sub || sub === 'peers' || sub === 'list' || sub === 'ls') return _handlePeers();
  if (sub === 'register' || sub === 'join') return _handleRegister(args, options);
  if (sub === 'send' || sub === 'msg' || sub === 'tell') return _handleSend(args, options);
  if (sub === 'inbox' || sub === 'recv' || sub === 'read') return _handleInbox(args);
  if (sub === 'attach') return _handleAttach(args);
  if (sub === 'detach') return _handleDetach(args);
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  printError(`未知子命令:${subCommand}。可用:peers / register / send / inbox / attach / detach / on / off。`);
  return 1;
}

module.exports = { handleMesh };
