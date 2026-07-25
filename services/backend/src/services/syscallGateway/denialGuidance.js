'use strict';

/**
 * denialGuidance.js — 高危拒绝的**可执行指引**生成器（纯叶子，零 IO，fail-soft）。
 *
 * 用户痛点:高危(红灯 L2)操作在非交互/自主(Goal)/管道/后台环境下被 fail-closed 拒绝时,
 * 只看到「无交互器,拒绝」——不知道**为什么**,更不知道**怎么办**。本叶子只对这一类
 * 「环境根本没给批准通道」的拒绝(cause='no-interactive-channel')产出一段中文可执行指引,
 * 讲清「为什么被拒 + 三条合规放行途径」。其余 cause(用户主动拒/确认串不匹配/交互异常)
 * 语义已自明,返回 null,不改现有措辞。
 *
 * **只浮现认知,绝不改变放行/拒绝判定**——它不接触权限门、不放松任何红线,纯 display。
 * 门控 KHY_GATEWAY_DENIAL_GUIDANCE(默认开,`0/false/off/no` 关闭即返回 null,逐字节回退
 * 「不附指引」的今日行为)。
 */

const { DENY_CAUSES } = require('./approvalRouter');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 指引是否启用(纯函数,门控默认开;仅 0/false/off/no 关闭)。 */
function isDenialGuidanceEnabled(env = process.env) {
  const raw = env && env.KHY_GATEWAY_DENIAL_GUIDANCE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 生成一段面向用户的可执行指引。仅对 no-interactive-channel 产出;其余 → null。
 *
 * @param {string} cause       approvalRouter 的 DENY cause
 * @param {object} [intent]    规约后的意图(可选,用于点名工具/动作,fail-soft)
 * @param {object} [env]       环境(默认 process.env)
 * @returns {string|null}      指引文本,或 null(门控关/非该类拒绝/坏输入)
 */
function buildDenialGuidance(cause, intent, env = process.env) {
  try {
    if (!isDenialGuidanceEnabled(env)) return null;
    if (cause !== DENY_CAUSES.NO_INTERACTIVE_CHANNEL) return null;
    const tool = intent && typeof intent === 'object' && intent.tool ? String(intent.tool) : '';
    const subject = tool ? `高危操作「${tool}」` : '此高危(红灯 L2)操作';
    return `${subject}需要当场键入确认,但当前为非交互环境(自主/管道/后台),无法弹出确认框——`
      + `故按安全默认拒绝(红线未放松)。若确需执行,请择一合规途径:`
      + `① 在交互式 TUI/REPL 中运行 khy,届时会弹出确认框请你键入 YES;`
      + `② 或在 ~/.khy/permissions.json 为该工具/命令配置放行策略(见 DESIGN-ARCH-058);`
      + `③ 破坏性/系统级红线操作请人工复核后再执行。`;
  } catch {
    return null; // fail-soft:指引生成失败绝不影响审批本身
  }
}

module.exports = { buildDenialGuidance, isDenialGuidanceEnabled };
