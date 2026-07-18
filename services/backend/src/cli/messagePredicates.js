'use strict';

/**
 * messagePredicates — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 对齐 Claude Code `src/utils/messagePredicates.ts::isHumanTurn`:
 *
 *     export function isHumanTurn(m) {
 *       return m.type === 'user' && !m.isMeta && m.toolUseResult === undefined
 *     }
 *
 * CC 源注释指出:tool_result 载体与真人回合**共享 `type:'user'`**,判别符是可选的
 * `toolUseResult` 字段。**四个 PR**(#23977 / #24016 / #24022 / #24025)分别修过
 * 「只判 `type==='user'` 就多算用户消息」的计数 bug——这是本刀收敛的同类缺口。
 *
 * Khy 现状(真缺口):khy 把多种**非真人** user 记录 push 进 `_messages`:
 *   - 工具结果载体(纯文本):`{role:'user', content:'[Tool Result]\n…'}`
 *     (ai.js:4938 / 5997 / 6003);
 *   - 工具结果载体(结构化块):`{role:'user', content:[{type:'tool_result',…}]}`
 *     (ai.js:4933);
 *   - 压缩摘要载体:`{role:'user', content:'[ContextCompact v2 @ …]…'}`(ai.js:1776)。
 * 而 `getConversationStats`(ai.js:1479-1486)对**每条** `role==='user'` 一律
 * `userMessages++`,于是 `/context` 的 `messages.user` 与
 * `会话摘要: …（用户 X …）`(router.js:1605 / 1643)把这些载体全算进「用户」——
 * 3 条真实提问可报「用户 12+」。
 *
 * 本叶子把 khy 的消息形状(`role` + `content` 字符串 / 块数组)映射到 CC 的
 * `(type + isMeta + toolUseResult)` 三判据:
 *   - `role` 必须是 `user`/`human`;
 *   - 显式 `isMeta === true` → 非真人(CC 同,前瞻兼容,khy 目前不设此字段);
 *   - `content` 是含 `tool_result` 块的数组、或以 `[Tool Result]` 开头的串 → 工具结果载体;
 *   - `content` 以 `[ContextCompact ` 开头的串 → 压缩摘要载体(meta)。
 *
 * 门控:KHY_HUMAN_TURN_COUNT(默认开)。`{0,false,off,no}`(大小写 / 空白不敏感)关 →
 * call-site 逐字节回退「每条 user 都 +1」。
 *
 * 诚实边界:khy 无 CC 的结构化 `isMeta` / `toolUseResult` 字段,只能按**内容前缀**辨识
 * 合成载体(`[Tool Result]` / `[ContextCompact `)。真人若手打恰以这些前缀开头会被误判
 * 为非真人——极罕见,作为有界取舍写在这里:宁可偶尔漏算一条真人,也不再系统性多算
 * 几十条工具载体。
 */

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

// 门控 KHY_HUMAN_TURN_COUNT。
function humanTurnCountEnabled(env = process.env) {
  const flag = String((env && env.KHY_HUMAN_TURN_COUNT) || '').trim().toLowerCase();
  return !OFF_VALUES.has(flag);
}

// content 若为「非真人 user 载体」,返回其种类('tool' | 'meta');否则 null。
function _userCarrierKind(content) {
  if (Array.isArray(content)) {
    // 结构化 tool_result 块(ai.js:4933)。
    for (const b of content) {
      if (b && b.type === 'tool_result') return 'tool';
    }
    return null;
  }
  if (typeof content === 'string') {
    if (content.startsWith('[Tool Result]')) return 'tool';       // ai.js:4938/5997/6003
    if (content.startsWith('[ContextCompact ')) return 'meta';    // ai.js:1776 压缩摘要
  }
  return null;
}

/**
 * user 消息的种类:`'human'` | `'tool'` | `'meta'`。非 user/human 角色 → `null`(绝不抛)。
 * @param {*} msg
 * @returns {('human'|'tool'|'meta'|null)}
 */
function userMessageKind(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const role = String(msg.role || msg.type || '').toLowerCase();
  if (role !== 'user' && role !== 'human') return null;
  if (msg.isMeta === true) return 'meta';
  const kind = _userCarrierKind(msg.content);
  return kind || 'human';
}

/**
 * CC `isHumanTurn` 的 khy 版:`role==='user'` 且非 meta、非工具结果载体。
 * @param {*} msg
 * @returns {boolean}
 */
function isHumanTurn(msg) {
  return userMessageKind(msg) === 'human';
}

module.exports = { humanTurnCountEnabled, userMessageKind, isHumanTurn };
