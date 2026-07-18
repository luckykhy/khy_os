'use strict';

/**
 * btw.js — `/btw`(by the way)命令薄壳:把一条补充提示**不打断当前请求**地排进共享队列,
 * 等下一回合并入用户输入一起发给模型。对齐 Claude Code 的「by the way」旁注语义。
 *
 * **背后逻辑**(规范化 + 「并入下一回合」的拼接格式)在纯叶子 conversation/btwNote.js;队列状态在
 * 进程级单例 store conversation/btwNoteQueue.js。经典 readline REPL 早有等价的闭包私有队列,但 router /
 * ink TUI 都看不见 → 本薄壳经路由把 `/btw` 接到**同一个**共享 store(优先增强既有机制,不另起炉灶):
 *   - 经典 REPL:仍由 repl.js 自身拦截 `/btw`(已重构为读写同一 store),不走本 handler。
 *   - ink TUI / 非交互分发:`/btw …` → router → 本 handler enqueue;TUI 在发真实消息前 drain+merge。
 *
 * 用法:`/btw <提示内容>`。门控 KHY_BTW 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo } = require('../formatters');
const leaf = require('../../services/conversation/btwNote');
const queue = require('../../services/conversation/btwNoteQueue');

/**
 * @param {string} _subCommand 预留(无子命令)
 * @param {string[]} args 提示内容(空格拼接成一条提示)
 * @param {object} _options 预留
 * @returns {Promise<true|false>}
 */
async function handleBtw(_subCommand, args = [], _options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('btw 命令未启用(KHY_BTW=off)。');
    return false;
  }

  const note = Array.isArray(args) ? args.join(' ') : String(args == null ? '' : args);
  const enqueued = queue.enqueue(note);
  if (!enqueued) {
    printInfo('用法: /btw <提示内容>');
    printInfo('AI 工作期间可排队补充提示,不会打断当前请求,会在下一回合并入。');
    printInfo(`当前队列: ${queue.count()} 条提示`);
    return true;
  }

  printInfo(`已排队补充提示(当前队列 ${queue.count()} 条),将在下一回合并入。`);
  return true;
}

module.exports = { handleBtw };
