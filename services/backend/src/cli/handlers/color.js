'use strict';

/**
 * color.js — `/color` 命令薄壳:给当前会话设/重置显示强调色(per-session)。
 * 对齐 Claude Code `/color`。
 *
 * **背后逻辑**(调色板校验、reset 别名、参数解析、措辞)全在纯叶子 `cli/sessionColor.js`;
 * 本壳只做副作用:门控、解析当前 sessionId、把颜色写进会话元数据(持久,
 * `updateSessionMetadata(id,{color})`,reset 写 'default' 哨兵)、更新进程级活动色
 * (`sessionColorState.setSessionColor` 让 Ink TUI 即时生效)、打印回执。
 *
 * 用法:`/color`(列出可用色)· `/color <色>`(设)· `/color default`(重置)。
 *
 * 门控 KHY_SESSION_COLOR 默认开;关 → 命令不接管(返回 false),TUI accent 字节回退。
 */

const { printInfo, printError, printSuccess } = require('../formatters');
const leaf = require('../sessionColor');
const colorState = require('../sessionColorState');

async function handleColor(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('color 命令未启用(KHY_SESSION_COLOR=off)。');
    return false;
  }

  let sessionId = null;
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
  } catch { /* best-effort */ }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /color 给会话设颜色。');
    return true;
  }

  const tokens = [subCommand].concat(Array.isArray(args) ? args : []).filter((t) => t != null && t !== '');
  const arg = leaf.parseColorArgs(tokens);

  // 无参 → 列出可用颜色。
  if (!arg) {
    printInfo(leaf.formatList());
    return true;
  }

  // reset 别名 → 写 'default' 哨兵(持久化重置)+ 进程级清空。
  if (leaf.isReset(arg)) {
    _persist(sessionId, 'default');
    colorState.setSessionColor(null);
    printSuccess(leaf.formatReset());
    return true;
  }

  if (!leaf.isValidColor(arg)) {
    printError(leaf.formatInvalid(arg));
    return true;
  }

  const color = leaf.normalizeColor(arg);
  if (!_persist(sessionId, color)) {
    printError('写入会话颜色失败 —— 未找到当前会话的快照文件(可能尚未持久化)。');
    return true;
  }
  colorState.setSessionColor(color);
  printSuccess(leaf.formatSet(color));
  return true;
}

function _persist(sessionId, color) {
  try {
    return !!require('../../services/sessionPersistence').updateSessionMetadata(sessionId, { color });
  } catch {
    return false;
  }
}

module.exports = { handleColor };
