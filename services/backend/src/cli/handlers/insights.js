'use strict';

/**
 * Insights Command Handler — `khy insights …`(对齐 Claude Code 的 /insights)。
 *
 * 会话洞见:回顾一段会话——轮次、最常用工具、话题关键词、耗时。统计/排版在纯叶子
 * sessionInsights(单一真源);transcript 读盘在 sessionPersistence。本 handler 只做 IO/打印。
 *
 *   insights [<sessionId>]   — 生成洞见报告(省略则取当前/最近一条会话)
 *   insights list            — 列出可分析的已持久化会话
 *   insights on | off        — 开/关会话洞见能力(持久化 KHY_INSIGHTS)
 *
 * @module handlers/insights
 */

const { printInfo, printError, printTable, printSuccess } = require('../formatters');

function _leaf() { return require('../../services/sessionInsights'); }
function _persistence() { return require('../../services/sessionPersistence'); }

function _persist(value, deps) {
  const writeEnvPatch = (deps && typeof deps.writeEnvPatch === 'function')
    ? deps.writeEnvPatch
    : require('./config')._writeEnvPatch;
  return writeEnvPatch({ KHY_INSIGHTS: value });
}

function _emit(text) {
  // 报告是多行 markdown,直接整段输出以保留排版(handler 是 IO 层)。
  console.log(text);
}

function _resolveSessionId(explicit) {
  if (explicit) return String(explicit);
  try {
    const recent = _persistence().listPersistedSessions({ limit: 1 });
    if (recent && recent.length) return recent[0].sessionId;
  } catch { /* fail-soft */ }
  return '';
}

function _handleReport(sessionId) {
  const leaf = _leaf();
  if (!leaf.isEnabled()) {
    printInfo('会话洞见能力已关闭（KHY_INSIGHTS=off）。开启:khy insights on');
    return 0;
  }
  const id = _resolveSessionId(sessionId);
  if (!id) {
    printInfo('暂无已持久化的会话可分析。');
    return 0;
  }
  let session;
  try {
    session = _persistence().restoreSession(id);
  } catch (e) {
    printError(`读取会话失败:${(e && e.message) || e}`);
    return 1;
  }
  if (!session) {
    printError(`找不到会话:${id}`);
    return 1;
  }
  _emit(leaf.buildInsightsReport(leaf.computeInsights(session)));
  return 0;
}

function _handleList() {
  let sessions;
  try {
    sessions = _persistence().listPersistedSessions({ limit: 50 });
  } catch (e) {
    printError(`列出会话失败:${(e && e.message) || e}`);
    return 1;
  }
  if (!sessions || !sessions.length) {
    printInfo('还没有已持久化的会话。');
    return 0;
  }
  const rows = sessions.map((s) => [
    s.sessionId || '-',
    (s.title || '(无标题)').length > 40 ? `${s.title.slice(0, 37)}...` : (s.title || '(无标题)'),
    String(s.messageCount || 0),
    s.model || '-',
  ]);
  printTable(['会话 ID', '标题', '消息数', '模型'], rows);
  printInfo('查看洞见:khy insights <会话 ID>');
  return 0;
}

function _handleToggle(turnOn, deps) {
  const value = turnOn ? 'true' : 'off';
  try {
    const p = _persist(value, deps);
    printSuccess(`✅ 会话洞见能力${turnOn ? '已开启' : '已关闭'}（KHY_INSIGHTS=${value}）。已即时生效并持久化。`);
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
function handleInsights(subCommand, args = [], options = {}, deps = {}) {
  const sub = String(subCommand || '').toLowerCase();
  if (sub === 'help' || options.help) {
    printInfo('用法: insights [<会话 ID>] | insights list | insights on | insights off');
    return 0;
  }
  if (sub === 'list' || sub === 'ls') return _handleList();
  if (sub === 'on') return _handleToggle(true, deps);
  if (sub === 'off') return _handleToggle(false, deps);
  if (!sub || sub === 'show' || sub === 'report') {
    // `khy insights` 或 `khy insights show [id]`
    return _handleReport(Array.isArray(args) ? args[0] : undefined);
  }
  // 其它:把第一个 token 当作 sessionId(khy insights <id>)
  return _handleReport(subCommand);
}

module.exports = { handleInsights };
