'use strict';

/**
 * tag.js — `/tag` 命令薄壳:给当前会话打/去可搜索标签。对齐 Claude Code `/tag`
 * (同一标签再打一次 = 移除)。
 *
 * **背后逻辑**(参数解析、toggle 切换、去重保序、算出完整新数组)全在纯叶子
 * `cli/sessionTag.js`;本壳只做副作用:门控、解析当前 sessionId(既有
 * `sessionForestService.getCurrentSessionId`)、读现有标签(既有
 * `sessionPersistence.loadSessionMeta(id).metadata.tags`)、把叶子算出的完整 `tags` 数组用既有
 * `sessionPersistence.updateSessionMetadata(id, { tags })` 写回(浅合并整组覆盖)、打印回执。
 *
 * 用法:`/tag`(列出当前标签)· `/tag <名...>`(打/去标签,逗号或空格分隔)。
 *
 * 门控 KHY_TAG 默认开;关 → 命令不接管(返回 false 字节回退)。
 */

const { printInfo, printError, printSuccess } = require('../formatters');
const leaf = require('../sessionTag');

function _readTags(sessionId) {
  try {
    const meta = require('../../services/sessionPersistence').loadSessionMeta(sessionId);
    const tags = meta && meta.metadata && meta.metadata.tags;
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}

async function handleTag(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('tag 命令未启用(KHY_TAG=off)。');
    return false;
  }

  let sessionId = null;
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
  } catch { /* best-effort */ }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /tag 给会话打标签。');
    return true;
  }

  const tokens = [subCommand].concat(Array.isArray(args) ? args : []).filter((t) => t != null && t !== '');
  const requested = leaf.parseTagArgs(tokens);
  const current = _readTags(sessionId);

  // 无参 → 只读列出当前标签。
  if (requested.length === 0) {
    if (current.length === 0) {
      printInfo('当前会话没有标签。用法:/tag <名...>(逗号或空格分隔;同名再打一次=移除)。');
    } else {
      printInfo('当前会话标签:' + current.map((t) => '#' + t).join(' '));
    }
    return true;
  }

  const { tags, added, removed } = leaf.applyTags(current, requested);

  let ok = false;
  try {
    ok = !!require('../../services/sessionPersistence').updateSessionMetadata(sessionId, { tags });
  } catch (e) {
    printError('写入会话标签失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  if (!ok) {
    printError('写入会话标签失败 —— 未找到当前会话的快照文件(可能尚未持久化)。');
    return true;
  }

  const parts = [];
  if (added.length) parts.push('已添加 ' + added.map((t) => '#' + t).join(' '));
  if (removed.length) parts.push('已移除 ' + removed.map((t) => '#' + t).join(' '));
  printSuccess((parts.join(';') || '标签无变化') + '。当前标签:' + (tags.length ? tags.map((t) => '#' + t).join(' ') : '(无)'));
  return true;
}

module.exports = { handleTag };
