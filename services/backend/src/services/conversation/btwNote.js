'use strict';

/**
 * btwNote.js — `/btw`(by the way · 旁注/补充提示)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;文本与 env 全经入参注入,本叶子绝不读
 * process.env、绝不触文件、绝不 spawn、绝不调 Date、绝不调 crypto、绝不持有可变状态(队列状态
 * 归薄壳 store btwNoteQueue.js,本叶子只做纯文本逻辑)。
 *
 * 背后的逻辑(对齐 Claude Code /btw):CC 的「by the way」让你在模型工作时**不打断当前请求**地
 * 排队一条补充提示,等下一回合**并入**用户输入一起发给模型 —— 区别于「打断/抢占」与「立刻另起一回合
 * (aiForward)」。khy 经典 REPL 早有等价语义(repl.js 的 `_btwQueue`:忙时排队、下回合前并入),但
 * 队列是 repl.js 闭包私有,router 与 ink TUI 都看不到 → `/btw` 在 TUI / 经路由分发时无法触达。本叶子
 * 把其中**纯确定性**那块收敛成单一真源:补充提示的规范化与「并入下一回合输入」的拼接格式。
 *
 *   - normalizeNote(raw)          → 规范化一条补充提示(trim;非串/空 → '')
 *   - mergeHints(input, hints)    → 把排队的提示并入本回合输入(SSOT 拼接格式,经典 REPL 与 TUI 共用)
 *   - isEnabled(env)              → 门控 KHY_BTW(默认开;falsy 关 → 路由/ TUI 旁注面不激活)
 *
 * 队列的「排队/出队/计数」状态在薄壳 store conversation/btwNoteQueue.js(模块级单例,每进程一份 =
 * 每会话一份,正好对应一次 khy 调用的单一前端);真正的回显在各 call-site。本叶子只算文本。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _HINT_HEADER = '[附加提示]';
const _MAX_NOTE_LEN = 4000;

/**
 * 规范化一条补充提示:去首尾空白;非字符串 / 空 → 返回 ''(调用方据此决定是否入队)。
 * @param {*} raw
 * @returns {string}
 */
function normalizeNote(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  return s.length > _MAX_NOTE_LEN ? s.slice(0, _MAX_NOTE_LEN) : s;
}

/**
 * 把排队的补充提示并入本回合用户输入。这是经典 REPL 与 TUI **共用**的拼接格式单一真源,
 * 与历史 repl.js 行为逐字节一致:`${input}\n\n[附加提示]\n${hints.join('\n')}`。
 * 无提示 → 原样返回 input(逐字节不变)。
 * @param {string} input          本回合用户输入
 * @param {Array<string>} hints   已出队的补充提示(每条一行)
 * @returns {string}
 */
function mergeHints(input, hints) {
  const base = input == null ? '' : String(input);
  if (!Array.isArray(hints) || hints.length === 0) return base;
  const lines = [];
  for (const h of hints) {
    const n = normalizeNote(h);
    if (n) lines.push(n);
  }
  if (lines.length === 0) return base;
  return `${base}\n\n${_HINT_HEADER}\n${lines.join('\n')}`;
}

/**
 * 门控:KHY_BTW 默认开。falsy(0/false/off/no/空)→ 关。
 * 关时 → 新增的 router `/btw` 命令与 TUI 旁注出队不激活;经典 REPL 既有 `/btw` 拦截不受本门控影响
 * (那是纯重构后的等价行为,始终可用)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_BTW === undefined ? 'true' : e.KHY_BTW;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  normalizeNote,
  mergeHints,
  isEnabled,
  _HINT_HEADER,
  _MAX_NOTE_LEN,
};
