'use strict';

/**
 * btwNoteQueue.js — `/btw` 补充提示队列的进程级单一真源(薄壳 · 有状态,但零文件 IO)。
 *
 * 为什么存在:历史上 `/btw` 队列是 cli/repl.js 里的闭包私有变量 `_btwQueue`,只有经典 readline
 * REPL 自己看得见 → router 分发与 ink TUI 都触达不到这条「忙时排队、下回合并入」的语义。本模块把队列
 * 收敛成**模块级单例**(`require` 缓存保证全进程唯一一份)。一次 khy 启动 = 一个前端进程 = 一个会话,
 * 故「每进程一份队列」恰好等于「每会话一份」,语义正确。
 *
 * 边界:本模块**只**持有内存队列与增删计数,不做任何文件 / 网络 / spawn IO;纯文本逻辑(规范化、
 * 「并入下一回合」的拼接格式)全部委托给纯叶子 conversation/btwNote.js(单一真源)。回显归各 call-site。
 *
 * 三个 call-site 经此单例汇合:
 *   - cli/repl.js          经典 REPL:`/btw` 拦截 enqueue;回合前 drainAll → mergeHints 并入(纯重构)。
 *   - cli/router.js        路由 `/btw`(经 handlers/btw.js):TUI / 非交互分发时 enqueue。
 *   - tui/ink-components   ink TUI:发送真实消息前 drainAll → mergeHints 并入。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。
 */

const _btwLeaf = require('./btwNote');

// 模块级单例队列(require 缓存 → 全进程唯一)。
const _queue = [];

/**
 * 入队一条补充提示。经纯叶子 normalizeNote 规范化;空 → 不入队,返回 false。
 * @param {*} raw
 * @returns {boolean} 是否真的入队
 */
function enqueue(raw) {
  const note = _btwLeaf.normalizeNote(raw);
  if (!note) return false;
  _queue.push(note);
  return true;
}

/**
 * 当前队列长度。
 * @returns {number}
 */
function count() {
  return _queue.length;
}

/**
 * 取出并清空整个队列(下回合并入时调用)。返回提示数组(可能为空)。
 * @returns {Array<string>}
 */
function drainAll() {
  return _queue.splice(0);
}

/**
 * 清空队列(不返回内容)。供 /clear 等场景。
 */
function clear() {
  _queue.length = 0;
}

module.exports = {
  enqueue,
  count,
  drainAll,
  clear,
};
