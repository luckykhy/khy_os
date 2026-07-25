'use strict';

/**
 * Notify Command Handler — `khy notify …`(对齐 Claude Code 的 off-terminal 推送)。
 *
 * 配置一个推送目标(ntfy / Bark / Discord / Slack / 通用 webhook),之后 khy 在长任务完成或
 * 阻塞点可把消息推到终端之外。报文格式在纯叶子 pushNotifyCore(单一真源);配置落 ~/.khyos/push.json(0600)。
 *
 *   notify [status]              — 查看当前推送配置(target 脱敏)
 *   notify set <provider> <目标>  — 设置推送目标(省略目标则从 stdin 读,避免进 shell 历史)
 *   notify test                  — 发一条测试通知
 *   notify send <标题> [正文]      — 发一条通知
 *   notify clear                 — 清除配置
 *   notify on | off              — 开/关推送能力(持久化 KHY_PUSH_NOTIFY)
 *
 * @module handlers/notify
 */

const { printInfo, printError, printTable, printSuccess } = require('../formatters');

function _core() { return require('../../services/pushNotifyCore'); }
function _store() { return require('../../services/pushConfigStore'); }

function _persist(value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ KHY_PUSH_NOTIFY: value });
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
  const cfg = _store().getConfig();
  if (!cfg) {
    printInfo('尚未配置推送。设置:khy notify set <provider> <目标>');
    const rows = _core().describeProviders().map((p) => [p.id, p.label, p.hint]);
    printTable(['provider', '名称', 'target 说明'], rows);
    return 0;
  }
  printTable(['服务商', '目标(掩码)', '更新于'], [[cfg.provider, _core().maskTarget(cfg.target), cfg.updatedAt || '-']]);
  printInfo('测试:khy notify test。模型也可在长任务完成时调用 PushNotify 工具主动提醒你。');
  return 0;
}

function _handleSet(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const provider = list.shift();
  if (!provider) {
    printError(`用法:khy notify set <provider> <目标>。provider 可选:${Object.keys(_core().PROVIDERS).join(' / ')}`);
    return 1;
  }
  let target = list.join(' ').trim();
  if (!target) target = _readStdinValue();
  if (!target) {
    printError('目标不能为空。例如 `khy notify set ntfy my-topic`,或 `echo -n <webhook> | khy notify set discord`。');
    return 1;
  }
  const res = _store().setConfig(provider, target);
  if (!res.ok) {
    printError(`设置失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ 已配置推送:${res.provider}(${res.preview})。`);
  printInfo('发测试:khy notify test。');
  return 0;
}

async function _doSend(title, body) {
  // 复用工具的发送路径,保证与模型调用一致(SSRF 守卫 + 脱敏)。
  const tool = require('../../tools/PushNotify');
  const res = await tool.execute({ title, body });
  return res;
}

async function _handleTest() {
  if (!_store().isConfigured()) {
    printError(_core().buildNotConfiguredHint());
    return 1;
  }
  const res = await _doSend('khy 测试通知', '如果你收到这条,说明推送已打通。');
  if (!res || !res.success) {
    printError(`测试失败:${(res && res.error) || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ ${res.data ? res.data.summary : '已发送测试通知。'}`);
  return 0;
}

async function _handleSend(args) {
  const list = Array.isArray(args) ? args.slice() : [];
  const title = list.shift();
  if (!title) {
    printError('用法:khy notify send <标题> [正文]');
    return 1;
  }
  const body = list.join(' ');
  const res = await _doSend(title, body);
  if (!res || !res.success) {
    printError(`发送失败:${(res && res.error) || '未知错误'}`);
    return 1;
  }
  printSuccess(`✅ ${res.data ? res.data.summary : '已发送。'}`);
  return 0;
}

function _handleClear() {
  const res = _store().clearConfig();
  if (!res.ok) {
    printError(`清除失败:${res.error || '未知错误'}`);
    return 1;
  }
  printSuccess('✅ 已清除推送配置。');
  return 0;
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist(value, deps);
    printSuccess(`✅ 推送通知能力${turnOn ? '已开启' : '已关闭'}（KHY_PUSH_NOTIFY=${value}）。已即时生效并持久化。`);
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
function handleNotify(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || 'status').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo('用法: notify [status] | notify set <provider> <目标> | notify test | notify send <标题> [正文] | notify clear | notify on | notify off');
    printInfo(`provider: ${Object.keys(_core().PROVIDERS).join(' / ')}。把消息推到终端之外(手机/桌面);目标由你自配,khy 不自带后端。`);
    return 0;
  }
  if (!sub || sub === 'status' || sub === 'show') return _handleStatus();
  if (sub === 'set' || sub === 'config') return _handleSet(args);
  if (sub === 'test') return _handleTest();
  if (sub === 'send' || sub === 'push') return _handleSend(args);
  if (sub === 'clear' || sub === 'rm' || sub === 'remove' || sub === 'unset') return _handleClear();
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  printError(`未知子命令:${subCommand}。可用:status / set / test / send / clear / on / off。`);
  return 1;
}

module.exports = { handleNotify };
