'use strict';

/**
 * Vault Command Handler — `khy vault …`(对齐 Claude Code 的密钥保险库)。
 *
 * 把 API token 等机密存进本地保险库(~/.khyos/vault,文件 0600),模型发 HTTP 请求时用
 * 占位符 `{{vault:NAME}}` 引用,真值由 VaultHttpFetch 在服务端注入,绝不进入模型上下文。
 * 校验/脱敏在纯叶子 vaultCore(单一真源);持久化在 vaultStore。本 handler 只做 IO/打印。
 *
 *   vault [list|ls]            — 列出所有密钥(掩码,绝不显示明文)
 *   vault set <名称> [值]       — 存入/更新密钥(省略值则从 stdin 读,避免进 shell 历史)
 *   vault get <名称>            — 查看某密钥(默认掩码;--reveal 才显示明文)
 *   vault rm <名称>            — 删除某密钥
 *   vault on | off            — 开/关保险库能力(持久化 KHY_VAULT)
 *
 * 安全:除非显式 --reveal,任何路径都不打印明文值。
 *
 * @module handlers/vault
 */

const { printInfo, printError, printTable, printSuccess } = require('../formatters');

function _store() { return require('../../services/vaultStore'); }

function _persist(value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ KHY_VAULT: value });
}

function _handleList() {
  const secrets = _store().listSecrets();
  if (!secrets.length) {
    printInfo('保险库是空的。存入:khy vault set <名称> <值>');
    return 0;
  }
  const rows = secrets.map((s) => [s.name, s.preview, String(s.length), s.updatedAt || s.createdAt || '-']);
  printTable(['名称', '预览(掩码)', '长度', '更新于'], rows);
  printInfo('在请求里用 {{vault:名称}} 引用;真值由 VaultHttpFetch 服务端注入,绝不进入模型上下文。');
  return 0;
}

function _readStdinValue() {
  // 省略值时从 stdin 读一行(避免密钥进入 shell 历史/进程列表)。非交互无输入则返回 ''。
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(0, 'utf-8');
    return String(buf || '').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

function _handleSet(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const name = list.shift();
  if (!name) {
    printError('用法:khy vault set <名称> [值]（省略值则从 stdin 读取,避免进入 shell 历史)');
    return 1;
  }
  let value = list.join(' ');
  if (!value) value = _readStdinValue();
  if (!value) {
    printError('密钥值不能为空。可:khy vault set <名称> <值>,或 `echo -n <值> | khy vault set <名称>`。');
    return 1;
  }
  const res = _store().setSecret(name, value);
  if (!res.ok) {
    printError(`存入失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 已存入密钥「${res.name}」(${res.preview})。`);
  printInfo(`在请求里这样引用:{{vault:${res.name}}}（例如 Authorization: "Bearer {{vault:${res.name}}}"）。`);
  return 0;
}

function _handleGet(args, options) {
  const name = Array.isArray(args) ? args[0] : args;
  if (!name) {
    printError('用法:khy vault get <名称> [--reveal]');
    return 1;
  }
  const store = _store();
  if (!store.hasSecret(name)) {
    printInfo(`保险库中没有密钥「${name}」。`);
    return 0;
  }
  const reveal = Boolean(options && (options.reveal || options.r));
  if (!reveal) {
    const found = store.listSecrets().find((s) => s.name === require('../../services/vaultCore').normalizeName(name));
    printInfo(`密钥「${name}」:${found ? found.preview : '(存在)'}`);
    printInfo('如确需查看明文(注意可能进入终端记录),加 --reveal。');
    return 0;
  }
  printInfo('⚠️ 正在显示明文密钥,请确保终端/录屏环境安全。');
  printInfo(`${require('../../services/vaultCore').normalizeName(name)} = ${store.getSecret(name)}`);
  return 0;
}

function _handleRemove(args) {
  const name = Array.isArray(args) ? args[0] : args;
  if (!name) {
    printError('用法:khy vault rm <名称>');
    return 1;
  }
  const res = _store().removeSecret(name);
  if (!res.ok) {
    printError(`删除失败:${res.error || '未知错误'}`);
    return 1;
  }
  if (!res.removed) {
    printInfo(`保险库中没有密钥「${name}」,无需删除。`);
    return 0;
  }
  printSuccess(`✅ 已删除密钥「${name}」。`);
  return 0;
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist(value, deps);
    printSuccess(`✅ 密钥保险库能力${turnOn ? '已开启' : '已关闭'}（KHY_VAULT=${value}）。已即时生效并持久化。`);
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
function handleVault(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'list').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo('用法: vault [list] | vault set <名称> [值] | vault get <名称> [--reveal] | vault rm <名称> | vault on | vault off');
    printInfo('引用密钥:在 VaultHttpFetch 的 url/headers/body 里写 {{vault:名称}};真值服务端注入,绝不进入模型上下文。');
    return 0;
  }
  if (!sub || sub === 'list' || sub === 'ls') return _handleList();
  if (sub === 'set' || sub === 'add' || sub === 'put') return _handleSet(args, options);
  if (sub === 'get' || sub === 'show') return _handleGet(args, options);
  if (sub === 'rm' || sub === 'remove' || sub === 'del' || sub === 'delete' || sub === 'unset') return _handleRemove(args);
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  printError(`未知子命令:${subCommand}。可用:list / set / get / rm / on / off。`);
  return 1;
}

module.exports = { handleVault };
