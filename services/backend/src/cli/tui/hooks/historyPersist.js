/**
 * historyPersist —— 纯叶子:TUI 输入历史持久化的确定性判定(零 IO / 确定性 / fail-soft / 单一真源)。
 *
 * 只做两件确定性的事;真正的文件读写交给既有 cli/repl/history.js(那是历史文件的单一真源,
 * 不在这里重造):
 *   - isPersistEnabled(envValue):判定调用方传入的原始 env 值,默认开,仅 0/false/off/no
 *     关 → 字节回退(关掉就退回「仅本会话内存历史」的旧行为)。本叶子不读 process.env;
 *     真正读取并传入的是消费者 useTextInput.js,复用见 KHY_TUI_HISTORY_PERSIST 的消费点。
 *   - mergeHistory(persisted, session, max):把「跨会话持久历史」与「本会话内存历史」按 旧→新
 *     合并、去空白、截到最近 max 条(供 Up 键从尾部往前回溯,最近的先出)。绝不读文件、绝不抛。
 */
'use strict';

const DISABLED = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控:默认开,仅 0/false/off/no(大小写无关)关。
 * @param {string|undefined|null} envValue - process.env.KHY_TUI_HISTORY_PERSIST 的原始值
 * @returns {boolean}
 */
function isPersistEnabled(envValue) {
  if (envValue == null) return true;
  return !DISABLED.has(String(envValue).trim().toLowerCase());
}

/**
 * 合并持久历史 + 本会话历史(旧→新),去空白项,截到最近 max 条。
 * @param {string[]} persisted - 来自历史文件,旧→新
 * @param {string[]} session - 本会话内存历史,旧→新
 * @param {number} [max] - 上界;省略 / 非法则不截断
 * @returns {string[]}
 */
function mergeHistory(persisted, session, max) {
  const clean = (arr) =>
    (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim() !== '') : []);
  const merged = clean(persisted).concat(clean(session));
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : merged.length;
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

module.exports = { isPersistEnabled, mergeHistory };
