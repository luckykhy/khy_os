'use strict';

/**
 * replyDedup.js — 纯叶子:折叠「整段回复被逐字重复两遍」的弱模型退化输出。
 *
 * 缺口(dogfood,provider api:agnes:agnes-2.0-flash · khy OS v0.1.165):工具轮结束后弱模型在
 * **单次回复**里把整段答案生成了两遍(reply = A + A,A 为数百字的完整旅游答案),渲染一次即在
 * 屏幕上出现两遍、逐字节相同、首尾直接拼接、无分隔。既有守卫都不覆盖此形状:
 *   - streamRepetitionGuard 只抓 ≤48 字短单元的高次数 chanting(maxUnit:48 / minRepeats:12),
 *     刻意放过「整段段落级重复两遍」;
 *   - answerEchoGuard 只做**跨轮**答案回声(本轮答案复现了本轮已流式过的某答案),抓不到
 *     **单次 completion 内**的自我重复;
 *   - renderDedup 只抑制「final 与已流式串重复」,不折叠 completion 自身内部的 A+A。
 * 本叶子补这条:检测「整条回复恰为两份完全相同的实质文本(中间至多夹少量纯空白)」→ 折叠为一份。
 *
 * 零假阳性铁律:只折叠**精确等半**——A === B(中间仅纯空白)且每份去空白字符数达阈值。合法散文里
 * 一段实质文本恰好逐字构成整条回复的另一半,概率可忽略;短/巧合重复由阈值挡掉。任何不精确匹配的
 * 输入一律**逐字节原样返回**。
 *
 * 门控 KHY_REPLY_DEDUP(默认开);0/false/off/no → 关 → 恒返回原文(逐字节回退)。
 * 契约:纯函数 · 零 IO · 确定性(无时钟/随机)· 绝不抛(异常/非字符串 → 原样返回)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 每份(去空白后)实质字符数下限:低于此不折叠,避免短句/标点的巧合等半重复被误伤。
// 报告中的旅游答案每份数百字,远高于此;40 是既能抓中等长度答案、又能拒短巧合的安全地板。
const MIN_HALF_NONSPACE = 40;
// 两份之间允许的纯空白间隔字符数上限(容忍 "A\n\nA" / "A A" 之类的拼接缝)。
const MAX_GAP = 8;

/**
 * 门控 KHY_REPLY_DEDUP:默认开;0/false/off/no → 关。异常 → 回退开门(true,保持默认行为)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function replyDedupEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_REPLY_DEDUP;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return true;
  }
}

/**
 * 若整条回复恰为「A + 纯空白间隔 + A」(A 去空白字符数 ≥ MIN_HALF_NONSPACE),折叠为 A;
 * 否则**逐字节原样返回**。门关 / 异常 / 非字符串 / 太短 → 原样返回。
 *
 * @param {string} text                  待检测的回复文本
 * @param {Record<string,string>} [env]  注入 env(可测)
 * @returns {string}
 */
function collapseDuplicatedReply(text, env = process.env) {
  try {
    if (typeof text !== 'string' || text.length === 0) return text;
    if (!replyDedupEnabled(env)) return text;

    const trimmed = text.trim();
    const len = trimmed.length;
    // 两份各需 ≥ MIN_HALF_NONSPACE 个非空白字符 → 总长必然 ≥ 2*阈值,否则不可能达标。
    if (len < 2 * MIN_HALF_NONSPACE) return text;

    // gap = 两份之间的纯空白间隔长度。逐一试 0..MAX_GAP,取首个精确等半且中间纯空白的切分。
    for (let gap = 0; gap <= MAX_GAP; gap++) {
      if ((len - gap) % 2 !== 0) continue;         // 剩余长度须能被平分为两份
      const half = (len - gap) / 2;
      if (half < MIN_HALF_NONSPACE) continue;      // 每份长度下限(含空白)的快速剪枝
      const a = trimmed.slice(0, half);
      const mid = trimmed.slice(half, half + gap);
      const b = trimmed.slice(half + gap);
      if (a === b && /^\s*$/.test(mid)) {
        // 精确等半且中缝纯空白 → 再确认每份实质字符达阈值,才折叠(挡短巧合)。
        if (a.replace(/\s/g, '').length >= MIN_HALF_NONSPACE) return a;
      }
    }
    return text;
  } catch {
    return text;
  }
}

module.exports = {
  replyDedupEnabled,
  collapseDuplicatedReply,
  MIN_HALF_NONSPACE,
  MAX_GAP,
};
