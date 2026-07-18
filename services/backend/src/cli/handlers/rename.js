'use strict';

/**
 * rename.js — `/rename` 命令薄壳:重命名当前会话标题。对齐 Claude Code `/rename`
 * (CC 无参时用模型生成 kebab 名)。
 *
 * **背后逻辑**(原子写 JSON 快照 + 标题 trim/200 上限 + 搜索索引刷新)全在既有 SSOT
 * `sessionPersistence.renameSession`;本薄壳绝不另起炉灶,只做:门控、解析当前 sessionId
 * (既有 `sessionForestService.getCurrentSessionId`)、拼接新标题、调用并打印回执。
 *
 * 用法:`/rename <新标题>`(标题可含空格,余下参数全拼为标题)。
 *
 * **诚实差异**:CC 无参时调用模型生成名字;khy 不在此命令里偷偷起模型回合 —— 无参一律
 * 提示「请显式给出标题」,绝不伪造一个模型生成的名字。
 *
 * 门控 KHY_RENAME 默认开;关 → 命令不接管(返回 false 字节回退)。
 */

const { printInfo, printError, printSuccess } = require('../formatters');

function _renameEnabled(env) {
  const raw = env && env.KHY_RENAME;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

async function handleRename(subCommand, args = [], _options = {}) {
  if (!_renameEnabled(process.env)) {
    printInfo('rename 命令未启用(KHY_RENAME=off)。');
    return false;
  }

  // 新标题 = subCommand + args 全部拼接(允许空格)。
  const parts = [subCommand].concat(Array.isArray(args) ? args : []).filter((t) => t != null && t !== '');
  const newTitle = parts.join(' ').trim();
  if (!newTitle) {
    printInfo('用法:/rename <新标题>。khy 不在此命令里调用模型生成名字 —— 请显式给出标题。');
    return true;
  }

  let sessionId = null;
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
  } catch { /* best-effort */ }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /rename 重命名。');
    return true;
  }

  let ok = false;
  try {
    ok = !!require('../../services/sessionPersistence').renameSession(sessionId, newTitle);
  } catch (e) {
    printError('重命名失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  if (ok) {
    printSuccess('会话已重命名为:' + newTitle.slice(0, 200));
  } else {
    printError('重命名失败 —— 未找到当前会话的快照文件(可能尚未持久化)。');
  }
  return true;
}

module.exports = { handleRename };
