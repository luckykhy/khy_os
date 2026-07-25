'use strict';

/**
 * compactInstructions.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「学 CC 显示但**更重背后逻辑**」+「/菜单命令全部补齐」。
 * CC 的 `/compact <instructions>`(src/commands/compact/compact.ts:53
 * `const customInstructions = args.trim()`)把命令后的自由文本作为**摘要聚焦指令**
 * 交给压缩器(compact.ts:92/107 threads customInstructions → getCompactPrompt
 * 追加 "Additional Instructions:")。用户借此把「这轮压缩重点保留 X」讲给总结器。
 *
 * 真缺口(核实链路 router.js:1298 → ai.js compactHistory):khy 的 `/compact`
 * 派发**硬编码** `ai.compactConversation({ mode: 'auto' })`,把已解析出的用户参数
 * (`parsed.args` / `parsed.subCommand`)**丢弃**。而 khy 实际运行的摘要器
 * `cli/ai.js:1644 compactHistory` **早已有活的聚焦槽**:
 *   :1650  const focus = _normalizeSummaryText(options.instructions || options.focus || '', 300);
 *   :1739  if (focus) lines.push(`Focus priority: ${focus}`);
 * 即 substrate 完整(总结器认 options.instructions 并把 "Focus priority: …" 注入摘要),
 * 只是命令入口从不喂它 —— 典型「live substrate 半接线」(与 rewind diff-stat 同族)。
 *
 * 本叶子把「解析后的命令 token → compactConversation 的 options 对象」这段纯决策
 * 抽出来单测:门控开且用户确实打了参数 → `{ mode:'auto', instructions:<文本> }`;
 * 门控关 / 无参数 → `{ mode:'auto' }`(与今日逐字节一致)。真正的压缩由调用方
 * (router)执行,叶子只产 options。
 *
 * 门控 KHY_COMPACT_INSTRUCTIONS(默认开;{0,false,off,no} 关)。关 →
 * `buildCompactOptions` 恒返 `{ mode:'auto' }`,逐字节回退今日行为。
 *
 * 诚实边界(刻意):① 只把参数接进 khy 实际使用的 compactHistory 聚焦槽
 * (options.instructions);**不**改道去 services/compact/* 那套 getCompactPrompt 通路
 * (那是与 /compact 无接线的独立 LLM 摘要子系统,改道=大结构变更,留后续)。两条
 * 摘要通路语义不同各自正确,本刀只补「命令参数触达 khy 现用摘要器」这一最小缺口。
 * ② 菜单选择 / 快捷键触发的 /compact 无自由文本 → 无 instructions → 与今日一致
 * (只有**打字** `/compact <文本>` 携带聚焦指令)。③ 聚焦文本仅做空白归一 + 去空,
 * 长度上限交由 compactHistory 的 _normalizeSummaryText(300)裁,叶子不重复截断。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/**
 * 是否把 /compact 的自由文本参数接进摘要聚焦。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function compactInstructionsEnabled(env = process.env) {
  const raw = env && env.KHY_COMPACT_INSTRUCTIONS;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * 从解析后的命令 token 重建用户聚焦文本(空白归一 + 去空)。绝不抛。
 * `[subCommand, ...args]` 兼容不同 parser 变体(有的把首 token 放 subCommand)。
 * @param {{subCommand?:string, args?:string[]}} [parsed]
 * @returns {string}  无参数 → ''
 */
function extractCompactInstructions(parsed) {
  const p = parsed || {};
  const parts = [];
  if (p.subCommand != null) parts.push(String(p.subCommand));
  if (Array.isArray(p.args)) {
    for (const a of p.args) { if (a != null) parts.push(String(a)); }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 构造 `/compact` 派发给 compactConversation 的 options 对象。
 *   门控关 / 无参数 → `{ mode:'auto' }`(逐字节回退今日行为)
 *   门控开 + 有参数 → `{ mode:'auto', instructions:<文本> }`
 * @param {{subCommand?:string, args?:string[]}} [parsed]
 * @param {object} [env]
 * @returns {{mode:string, instructions?:string}}
 */
function buildCompactOptions(parsed, env = process.env) {
  const base = { mode: 'auto' };
  if (!compactInstructionsEnabled(env)) return base;
  const text = extractCompactInstructions(parsed);
  if (!text) return base;
  return { mode: 'auto', instructions: text };
}

module.exports = {
  compactInstructionsEnabled,
  extractCompactInstructions,
  buildCompactOptions,
};
