'use strict';
/**
 * promptPlaceholder — 纯叶子 · 零 IO · 确定性 · 绝不抛。
 *
 * CC `components/PromptInput/usePromptInputPlaceholder.ts` 的输入框占位符优先级
 * 阶梯的后端决策逻辑。khy 原本只是 App.js 里一个静态两分支
 * (`reviewing ? reviewText : (busy ? '' : defaultText)`),缺 CC 的
 * 「有可编辑的排队消息且提示尚未用尽 → 提示按 ↑ 取回编辑」这一档。此叶子把整条
 * 阶梯收敛成单一真源,call-site 只喂状态位、拿回一个占位串。
 *
 * 诚实边界(刻意不做):
 *   - CC 还有一档 viewing-teammate → `Message @<name>…`,khy 无「查看队友会话」的
 *     substrate(没有 viewing-agent 态可读),honest-NA,绝不臆造。
 *   - CC 的 example-command / submitCount<1 建议档依赖 khy 未携带的建议引擎,不纳入。
 *
 * 门控 KHY_PROMPT_PLACEHOLDER_LADDER(默认开;`{0,false,off,no}` 关)。
 * 门控关 → 逐字节回退历史两分支。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

function promptPlaceholderLadderEnabled(env = process.env) {
  const v = String((env && env.KHY_PROMPT_PLACEHOLDER_LADDER) || '').trim().toLowerCase();
  return !FALSY.has(v);
}

// CC NUM_TIMES_QUEUE_HINT_SHOWN — 排队编辑提示最多提示几次后不再打扰用户。
const QUEUE_HINT_MAX_SHOWS = 3;

/**
 * @param {object} state
 *   reviewing          {boolean} plan 复核态(最高优先)。
 *   busy               {boolean} 有回合在飞。
 *   queueEditable      {boolean} 存在可编辑的排队(未发送)消息。
 *   queueHintExhausted {boolean} 排队编辑提示已用尽(计数 ≥ QUEUE_HINT_MAX_SHOWS)。
 *   reviewText         {string}  复核态占位串。
 *   busyText           {string}  忙态占位串(历史为空串)。
 *   defaultText        {string}  空闲默认引导串。
 *   queueHintText      {string}  「按 ↑ 编辑排队消息」提示串。
 * @param {object} env
 * @returns {string}
 */
function resolvePromptPlaceholder(state, env = process.env) {
  const s = state && typeof state === 'object' ? state : {};
  const reviewText = typeof s.reviewText === 'string' ? s.reviewText : '';
  const busyText = typeof s.busyText === 'string' ? s.busyText : '';
  const defaultText = typeof s.defaultText === 'string' ? s.defaultText : '';
  const queueHintText = typeof s.queueHintText === 'string' ? s.queueHintText : '';
  const reviewing = !!s.reviewing;
  const busy = !!s.busy;
  const queueEditable = !!s.queueEditable;
  const queueHintExhausted = !!s.queueHintExhausted;

  // 门控关 → 逐字节回退历史两分支。
  if (!promptPlaceholderLadderEnabled(env)) {
    return reviewing ? reviewText : (busy ? busyText : defaultText);
  }

  // CC 优先级阶梯(teammate 档 honest-NA 略):
  //   1) plan 复核态 → 复核提示(历史即最高优先,保持不变)。
  //   2) 有可编辑排队消息且提示未用尽 → 「按 ↑ 编辑排队消息」。
  //   3) 忙 → busyText(历史为空串)。
  //   4) 空闲 → 默认引导串。
  if (reviewing) return reviewText;
  if (queueEditable && !queueHintExhausted && queueHintText) return queueHintText;
  if (busy) return busyText;
  return defaultText;
}

module.exports = {
  promptPlaceholderLadderEnabled,
  resolvePromptPlaceholder,
  QUEUE_HINT_MAX_SHOWS,
};
