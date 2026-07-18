'use strict';

/**
 * copy.js — `/copy` 命令薄壳:把最近(或第 N 条)助手回复 / 其中代码块复制到系统剪贴板。
 * 对齐 Claude Code `/copy`。
 *
 * **背后逻辑**(参数解析、选第 N 条、抽代码块、拼载荷)全在纯叶子 `cli/copyReply.js`;本壳
 * 只做副作用:门控、解析当前 sessionId(既有 `sessionForestService.getCurrentSessionId`)、
 * 读 chain(既有 `sessionPersistence.buildConversationChain`)、把每条 assistant content 用既有
 * `contentBlockUtils.contentToText` 压平成纯文本(与 `share` 路径同一压平器,不另起炉灶)、
 * 调既有 `imageService.writeClipboardText` 写真实剪贴板、打印回执。
 *
 * 用法:`/copy`(复制最近助手回复)· `/copy N`(从最近往回数第 N 条)· `/copy code [N]`
 * (只复制其中的代码块)。
 *
 * **诚实边界**:khy 无 OSC52,走系统剪贴板工具(pbcopy/xclip/wl-copy/Set-Clipboard);若
 * 全部后端均不可用或无可复制内容,如实告知失败原因,绝不假装已复制。
 *
 * 门控 KHY_COPY 默认开;关 → 命令不接管(返回 false 字节回退)。
 */

const { printInfo, printError, printSuccess } = require('../formatters');
const leaf = require('../copyReply');

async function handleCopy(subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('copy 命令未启用(KHY_COPY=off)。');
    return false;
  }

  const tokens = [subCommand].concat(Array.isArray(args) ? args : []).filter((t) => t != null && t !== '');
  const { nth, codeOnly } = leaf.parseCopyArgs(tokens);

  let sessionId = null;
  try {
    sessionId = require('../../services/session/sessionForestService').getCurrentSessionId();
  } catch { /* best-effort */ }
  if (!sessionId) {
    printInfo('暂无活动会话 —— 先开始一段对话,再用 /copy 复制助手回复。');
    return true;
  }

  let chain = [];
  try {
    chain = require('../../services/sessionPersistence').buildConversationChain(sessionId);
  } catch (e) {
    printError('读取会话 transcript 失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  // 把 assistant content 压平成纯文本(复用 share 路径同一压平器)。
  let contentToText = (c) => (typeof c === 'string' ? c : '');
  try { contentToText = require('../../services/contentBlockUtils').contentToText; } catch { /* fallback above */ }
  const texts = [];
  for (const entry of Array.isArray(chain) ? chain : []) {
    if (!entry || entry.role !== 'assistant') continue;
    let t = '';
    try { t = String(contentToText(entry.content) || '').trim(); } catch { t = ''; }
    if (t) texts.push(t);
  }

  const built = leaf.buildCopyPayload(texts, { nth, codeOnly });
  if (!built.ok) {
    if (built.reason === 'no_reply') {
      printInfo('未找到可复制的助手回复' + (nth > 1 ? `(本会话不足 ${nth} 条助手回复)。` : '。'));
    } else if (built.reason === 'no_code') {
      printInfo('该助手回复里没有代码块(``` 围栏)可复制。');
    } else {
      printInfo('没有可复制的内容。');
    }
    return true;
  }

  let wrote = false;
  try {
    wrote = !!require('../../services/imageService').writeClipboardText(built.payload);
  } catch (e) {
    printError('写入剪贴板失败:' + (e && e.message ? e.message : String(e)));
    return true;
  }

  if (wrote) {
    printSuccess('已复制到剪贴板:' + built.description);
  } else {
    printError('无法写入系统剪贴板(未找到可用的剪贴板工具:pbcopy/xclip/wl-copy/Set-Clipboard)。');
  }
  return true;
}

module.exports = { handleCopy };
