'use strict';

/**
 * recentTurnsSplit.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 services/tokenless/commandRewriter.rewriteHistory 的「keepRecent:0 → slice(-0) 反转」缺陷(:40-41):
 *   const oldTurns = conversation.slice(0, -keepRecent);   // keepRecent=0 → slice(0,-0)=slice(0,0)=[]
 *   const recentTurns = conversation.slice(-keepRecent);   // keepRecent=0 → slice(-0)=slice(0)=整段
 * `-0 === 0`,故 keepRecent=0 时:oldTurns 空(啥都不摘要)、recentTurns 是整段(全"保留为最近")——
 * 与「保留 0 条最近、摘要全部历史」的语义**恰好相反**。default keepRecent=4 掩盖了它,只有显式传 0
 * (一个合理的"全部压缩"调用意图)会静默 no-op 掉整趟省 token。
 *
 * 本叶子把「保留最近 N 条」的切分收成单一真源,正确处理 keepRecent<=0:
 *   - splitRecent(conversation, keepRecent, env):
 *       门开 ∧ keepRecent<=0 → { oldTurns: 整段副本, recentTurns: [] }(保留 0 条 → 摘要全部);
 *       门开 ∧ keepRecent>0  → { oldTurns: slice(0,-N), recentTurns: slice(-N) }(与 legacy 逐字节一致);
 *       门关 / 非数组 / 异常 → 返回 null(调用方逐字节回退到 legacy slice 表达式,保留原反转写法)。
 *
 * 门控 KHY_RECENT_TURNS_SPLIT_GUARD(默认开;0/false/off/no 关 → null 回退)。
 * flagRegistry 优先,失败回退本地 CANON;绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_RECENT_TURNS_SPLIT_GUARD:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function recentTurnsSplitGuardEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_RECENT_TURNS_SPLIT_GUARD', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_RECENT_TURNS_SPLIT_GUARD;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 把会话切成 { oldTurns(待摘要), recentTurns(逐字保留) }。
 * @param {Array} conversation
 * @param {number} keepRecent
 * @param {Record<string,string>} [env]
 * @returns {{oldTurns: Array, recentTurns: Array}|null} 门开→切分;门关/非数组/异常→null(调用方 legacy)
 */
function splitRecent(conversation, keepRecent, env = process.env) {
  try {
    if (!recentTurnsSplitGuardEnabled(env)) return null;
    if (!Array.isArray(conversation)) return null;
    const n = Number(keepRecent);
    if (!Number.isFinite(n) || n <= 0) {
      return { oldTurns: conversation.slice(), recentTurns: [] };
    }
    return {
      oldTurns: conversation.slice(0, -n),
      recentTurns: conversation.slice(-n),
    };
  } catch {
    return null;
  }
}

module.exports = {
  recentTurnsSplitGuardEnabled,
  splitRecent,
};
