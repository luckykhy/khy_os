'use strict';

/**
 * footerStability.js — 纯叶子:消除 Ink TUI footer 渲染风暴的两个确定性判定的单一真源。
 *
 * 根因:`khy:adapter:status` 进程事件的 payload 契约**是字符串**(`kiroAdapter._emitStatus(text)`
 * 发字符串;`repl.js` 监听端 `(text) => emitRuntimeStatus(text)` 也按字符串用)。唯独 Ink 桥
 * `useQueryBridge.onStatus` 误把它当对象 spread(`{ ...p, ...info }`)——把字符串按字符炸成
 * `{0:'h',1:'i',…}`,且**每次都生成新对象身份**。`adapterInfo` 在 TUI 里唯一消费点是
 * `App.js` 那个 `refreshFooter` effect 的依赖项,身份一抖动 effect 就重跑、又撞上 `refreshFooter`
 * 里**无相等守卫**的 `setFooter`(每次返回新对象、无条件重渲染)→ 渲染风暴 → CPU 打满 → 界面
 * 卡死(用户体感「莫名其妙超时」)。本叶子把两处确定性判定收敛为可单测真源:
 *   - `normalizeAdapterStatus(payload)`:adapter status payload → 稳定字符串(契约 SSOT)。
 *   - `footersEqual(a, b)`:footer 身份字段浅比较,供 `setFooter` 守卫短路、返回原引用。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。无需 env 门控——这是修正
 * (correctness)而非可选能力,绝不提供「关掉就退回无限循环」的逃生阀。
 */

// footer 的「身份字段」:`refreshFooter` 覆盖的就是这五个;其余键由 `{ ...f }` 原样带过,
// 故这五个相等 ⇒ 候选对象与原对象在所有键上相等 ⇒ 可安全返回原引用、让 React 跳过重渲染。
const FOOTER_IDENTITY_KEYS = ['model', 'adapter', 'effort', 'contextLimit', 'contextPct'];

/**
 * 把一次 adapter status 事件的 payload 归一为稳定字符串。
 * 字符串 → 自身(trim);对象 → 取 message/phase/text/status 任一;其余 → ''。
 * 这是「adapter status payload 是什么」的单一真源,杜绝「字符串被按字符 spread」的身份抖动。
 * @param {*} payload
 * @returns {string}
 */
function normalizeAdapterStatus(payload) {
  if (typeof payload === 'string') return payload.trim();
  if (payload && typeof payload === 'object') {
    const cand = payload.message || payload.phase || payload.text || payload.status;
    if (typeof cand === 'string') return cand.trim();
  }
  return '';
}

/**
 * footer 身份字段浅相等。两侧在 FOOTER_IDENTITY_KEYS 上全等 → true。
 * 用于 `setFooter` 守卫:相等则返回原引用,避免无意义重渲染(渲染风暴的导火索)。
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function footersEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  for (const k of FOOTER_IDENTITY_KEYS) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

module.exports = {
  FOOTER_IDENTITY_KEYS,
  normalizeAdapterStatus,
  footersEqual,
};
