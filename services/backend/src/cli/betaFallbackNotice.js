'use strict';

/**
 * betaFallbackNotice.js — 纯叶子 (pure leaf)：把「服务端拒绝可选 beta 能力、已自动
 * 禁用并重试」这一降级事件,渲染成一行给用户看的 CC 风格提示。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、env 门控默认开 (KHY_BETA_FALLBACK_NOTICE)。
 *   本叶子不读文件/不连网/不做副作用——被剥掉的 beta 名单由调用方(claudeAdapter 的
 *   400 自愈重试)探测后作为参数传入,叶子只做确定性的文案组装。
 *
 * 为什么存在 (缺口)：claudeAdapter._maybeRetryWithoutBetas 在收到「可选 T0 beta 头
 *   (context-1m / interleaved-thinking) 触发的 400」时,会 sticky 关掉这些 beta 并原样
 *   重发一次——这是必需的功能性自愈,**永远发生、不受本门控影响**。但此前它只 console.warn
 *   到 stderr,在 ink 全屏 TUI 下用户完全看不到,而降级有真实后果(1M 预算可能仍按 1M 估算
 *   → 超 200k 溢出)。姊妹适配器 relayApiAdapter 早已用 `{type:'notice'}` chunk 把「去除
 *   工具重试」浮现给用户;本叶子让 claude 侧的 beta 降级走同一既有通道、同一约定。
 *
 * 诚实边界：
 *   - 只负责**文案**;是否重试、关哪些 beta 全由适配器决定(功能路径不门控)。
 *   - 门控关 / 空名单 / 坏输入 → 返回 null → 适配器不 emit notice → 逐字节回退今日行为
 *     (仍 console.warn、仍静默重试),仅少一行 TUI 提示。
 *   - 未知 beta token 原样透传(不臆造中文名),已知的映射到友好名。
 */

// 已知可选 beta → 友好中文名。未列出的原样显示。
const BETA_LABELS = {
  'context-1m': '1M 长上下文',
  'interleaved-thinking': '交错思考',
};

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** 是否启用用户面降级提示(门控 KHY_BETA_FALLBACK_NOTICE 默认开)。 */
function betaFallbackNoticeEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_BETA_FALLBACK_NOTICE) || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 组装一行 beta 降级提示。
 * @param {string[]} strippedBetas  被自动禁用的 beta token 列表(如 ['context-1m'])
 * @param {Object} [env]            门控 env
 * @returns {string|null}           一行中文提示,或 null(门控关/空名单/坏输入)
 */
function buildBetaFallbackNotice(strippedBetas, env) {
  try {
    if (!betaFallbackNoticeEnabled(env)) return null;
    if (!Array.isArray(strippedBetas)) return null;
    const known = [...new Set(
      strippedBetas
        .filter((b) => typeof b === 'string' && b.trim())
        .map((b) => b.trim().toLowerCase()),
    )];
    if (!known.length) return null;
    const friendly = known.map((b) => BETA_LABELS[b] || b).join('、');
    let text = `⚠ 服务端拒绝了可选能力（${friendly}），已自动禁用并重试（本会话）。`;
    // context-1m 降级有真实预算后果:上下文窗口回落到 200k,附一句告警。
    if (known.includes('context-1m')) {
      text += ' 上下文窗口回落到 200k，超长对话可能被截断。';
    }
    return text;
  } catch {
    return null;
  }
}

module.exports = {
  betaFallbackNoticeEnabled,
  buildBetaFallbackNotice,
  BETA_LABELS,
};
