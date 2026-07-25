'use strict';

/**
 * Msg Command Handler — `khy msg …` 多平台消息收发(钉钉 / 飞书 / 企业微信)。
 *
 * 填入平台「群机器人 webhook」(及可选的加签 / 收信密钥)后,khy 即可向群里发消息;
 * 若把本服务的 /webhooks/<平台> 地址配到平台后台,还能接收群里的消息(验签 + 解密 + 解析)。
 * 报文与加签在纯叶子 msgChannelCore / msgInboundCore(单一真源);配置落 ~/.khyos/msg.json(0600)。
 *
 *   msg [status]                       — 查看已配置的平台(webhook 脱敏)
 *   msg platforms                      — 列出支持的平台与「去哪拿 webhook」
 *   msg set <平台> <k>=<v> ...          — 设置配置(值为 - 时从 stdin 读,避免进 shell 历史)
 *                                        字段:webhook / secret / encryptKey / verificationToken /
 *                                             token / encodingAesKey(按平台)
 *   msg send <平台> <文本...>            — 立即发一条消息
 *   msg test <平台>                     — 发一条测试消息
 *   msg clear [平台]                    — 清除某平台(省略则清空全部)
 *   msg on | off                       — 开/关消息能力(持久化 KHY_MSG)
 *
 * @module handlers/msg
 */

const { printInfo, printError, printTable, printSuccess } = require('../formatters');

function _core() { return require('../../services/messaging/msgChannelCore'); }
function _store() { return require('../../services/messaging/msgConfigStore'); }
function _sender() { return require('../../services/messaging/msgSender'); }

function _persist(value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ KHY_MSG: value });
}

function _readStdinValue() {
  try {
    const fs = require('fs');
    return String(fs.readFileSync(0, 'utf-8') || '').replace(/\r?\n$/, '');
  } catch {
    return '';
  }
}

function _handleStatus() {
  const list = _store().listConfigured();
  if (!list.length) {
    printInfo('尚未配置任何平台。查看支持的平台:khy msg platforms。');
    return 0;
  }
  printTable(
    ['平台', '名称', 'webhook(掩码)', '含密钥'],
    list.map((p) => [p.platform, p.label, p.webhook, p.hasSecret ? '是' : '否']),
  );
  printInfo('发消息:khy msg send <平台> <文本>。接收需把 /webhooks/<平台> 配到平台后台。');
  return 0;
}

function _handlePlatforms() {
  printTable(
    ['平台', '名称', '去哪拿 webhook'],
    _core().describePlatforms().map((p) => [p.platform, p.label, p.hint]),
  );
  return 0;
}

function _handleSet(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const platform = list.shift();
  if (!platform) {
    printError('用法:khy msg set <平台> <k>=<v> ...。平台:dingtalk / feishu / wecom。');
    return 1;
  }
  const fields = {};
  for (const token of list) {
    const idx = String(token).indexOf('=');
    if (idx <= 0) {
      printError(`无法解析参数「${token}」,应为 k=v 形式(如 webhook=https://...)。`);
      return 1;
    }
    const key = token.slice(0, idx).trim();
    let val = token.slice(idx + 1);
    if (val === '-') val = _readStdinValue(); // 从 stdin 读,避免密钥进 shell 历史
    fields[key] = val;
  }
  if (!Object.keys(fields).length) {
    printError('至少给一个字段,如 webhook=https://...。');
    return 1;
  }
  const res = _store().setPlatform(platform, fields);
  if (!res.ok) {
    printError(`设置失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 已配置 ${res.platform}(${res.preview})。`);
  printInfo('发测试:khy msg test ' + res.platform + '。');
  return 0;
}

async function _sendVia(platform, text) {
  const cfg = _store().getPlatform(platform);
  if (!cfg) {
    return { ok: false, error: `平台「${platform}」尚未配置。先跑 khy msg set ${platform} webhook=<url>。` };
  }
  return _sender().sendText({ platform: cfg.platform, webhook: cfg.webhook, secret: cfg.secret, text });
}

async function _handleSend(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const platform = list.shift();
  const text = list.join(' ').trim();
  if (!platform || !text) {
    printError('用法:khy msg send <平台> <文本...>');
    return 1;
  }
  const res = await _sendVia(platform, text);
  if (!res.ok) {
    printError(`发送失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 已发送到 ${res.platform}(${res.target})。`);
  return 0;
}

async function _handleTest(args) {
  const platform = (Array.isArray(args) ? args[0] : '') || '';
  if (!platform) {
    printError('用法:khy msg test <平台>');
    return 1;
  }
  const res = await _sendVia(platform, 'khy 测试消息:如果你收到这条,说明发送已打通。');
  if (!res.ok) {
    printError(`测试失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 测试消息已发送到 ${res.platform}(${res.target})。`);
  return 0;
}

function _handleClear(args) {
  const platform = (Array.isArray(args) ? args[0] : '') || '';
  const res = _store().clearPlatform(platform || undefined);
  if (!res.ok) {
    printError(`清除失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(platform ? `✅ 已清除 ${res.platform}。` : '✅ 已清除全部平台配置。');
  return 0;
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist(value, deps);
    printSuccess(`✅ 消息收发能力${turnOn ? '已开启' : '已关闭'}(KHY_MSG=${value})。已即时生效并持久化。`);
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
 * @returns {number|Promise<number>}
 */
function handleMsg(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'status').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo('用法: msg [status] | msg platforms | msg set <平台> <k>=<v>... | msg send <平台> <文本> | msg test <平台> | msg clear [平台] | msg on | msg off');
    printInfo('平台: dingtalk / feishu / wecom。填群机器人 webhook 即可发送;接收需把 /webhooks/<平台> 配到平台后台。');
    return 0;
  }
  if (!sub || sub === 'status' || sub === 'show' || sub === 'list') return _handleStatus();
  if (sub === 'platforms' || sub === 'providers') return _handlePlatforms();
  if (sub === 'set' || sub === 'config') return _handleSet(args);
  if (sub === 'send' || sub === 'push') return _handleSend(args);
  if (sub === 'test') return _handleTest(args);
  if (sub === 'clear' || sub === 'rm' || sub === 'remove' || sub === 'unset') return _handleClear(args);
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  printError(`未知子命令:${subCommand}。可用:status / platforms / set / send / test / clear / on / off。`);
  return 1;
}

module.exports = { handleMsg };
