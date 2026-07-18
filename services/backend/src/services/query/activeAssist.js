'use strict';

/**
 * activeAssist.js — 「被动响应 → 主动协助 + 被动兜底」的单一真源。
 *
 * Goal (2026-06-25): khyos 中凡是「被动响应」的地方,都改为「主动协助 + 被动兜底」。
 * 被动响应 = 把模型产出 / 套话原样返回,不先主动检测缺口再补齐。典型痛点:
 *   回答输出完了但缺少总结 → 应主动监听到 → 补充总结 → 再显示。
 *
 * 项目里绝大多数被动接缝(空回复 / 截断 / 工具失败 / 语言不符)其实已被既有主动子系统
 * 包裹(forced-summary 收尾轮 / _buildOutcomeReflectionHint / 语言纠偏 / inertialContinuation),
 * 残留套话只是「主动手段穷尽后」的合法兜底。本模块只补齐三个真正裸露的缺口:
 *   A1 无工具长回答缺总结、A2 多智能体全失败的套话兜底、A3 空闲超时无内容直接认输。
 *   A4 语言不符已由 gateway 的语言纠偏完整覆盖,本模块不重复实现(见 RULES.A4_language)。
 *
 * 设计同 inertialContinuation.js:纯叶子,env 门控(默认开),冻结 RULES 文档化「何时主动」,
 * 只做判定 + 给指令/兜底文案,绝不发起模型调用、绝不渲染;任何错误 fail-soft 回落今天行为。
 */

const MASTER_FLAG = 'KHY_ACTIVE_ASSIST';
const SUMMARY_FLAG = 'KHY_ACTIVE_ASSIST_SUMMARY';
const AGENT_FLAG = 'KHY_ACTIVE_ASSIST_AGENT';
const IDLE_FLAG = 'KHY_ACTIVE_ASSIST_IDLE';

// 「长回答」阈值:与 toolUseLoop 的 concludeNow 短路(>= 400 非空白字符)对齐,
// 这样恰好覆盖那条会跳过所有收尾 nudge 的长回答路径,短回答不受打扰。
const SUMMARY_MIN_CHARS = 400;
// 抢救子代理产出 / 错误说明所需的最小可见字符,低于此视为无信息。
const SALVAGE_MIN_CHARS = 12;

/**
 * env 门控惯例(同 inertialContinuation.isEnabled):默认开,仅显式 0/false/off/no 关。
 * @param {string} flag
 * @returns {boolean}
 */
function flagOn(flag) {
  const v = String(process.env[flag] == null ? '' : process.env[flag]).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 主闸:任一子能力都先过主闸。 */
function isEnabled() { return flagOn(MASTER_FLAG); }
/** A1 缺总结子闸。 */
function summaryAssistEnabled() { return isEnabled() && flagOn(SUMMARY_FLAG); }
/** A2 多智能体全失败子闸。 */
function agentAssistEnabled() { return isEnabled() && flagOn(AGENT_FLAG); }
/** A3 空闲超时续接子闸。 */
function idleAssistEnabled() { return isEnabled() && flagOn(IDLE_FLAG); }

// 「是否已含真正的总结/结论」判据的单一真源。toolUseLoop._looksLikeDeliveryConclusion
// 改为委派此函数,消除两份判据。
//
// 顺滑修(2026-06-25):原正则英文一侧只认 completed/summary/finished,漏掉「complete」
// 「final answer」「in summary」「in conclusion」等极常见的收尾措辞 —— 一段明显已收尾的
// 实质回答(如 "...a complete and substantive final answer.")会因词形差一字被判「缺总结」,
// 被强行追加一轮「补总结」,这恰恰是不顺滑(已答完还在转圈)。故补齐英文收尾措辞与两个
// 无歧义的中文收尾词(综上 / 小结)。本判据**只用于抑制**主动补总结轮(命中 → 不追问),
// 放宽永远只会少追问、不会多追问,故零回归风险。
const CONCLUSION_RE = /(完成|成功|已整理|已创建|已修改|无需|部分完成|最终结论|结果|总结|完成摘要|综上|小结|done|completed?|summary|summari[sz]e|result|created|modified|finished|finalized|final answer|in (summary|conclusion)|to (summari[sz]e|conclude)|overall|wrapped up|all set|no.*needed|partial)/i;

/**
 * 文本是否已经携带一个明确的交付结论/总结。
 * @param {string} text
 * @returns {boolean}
 */
function hasSynthesizedConclusion(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return CONCLUSION_RE.test(normalized);
}

// ── RULES:何时主动协助 / 何时不(冻结,文档即契约)───────────────────────────
const RULES = Object.freeze({
  A1_summary:
    '输出完成但缺总结/结论 → 主动推一轮(禁用工具)让模型补收尾;补不出再由服务端合成一句兜底。'
    + ' 仅对「无工具、足量(>= SUMMARY_MIN_CHARS)、非纯进度前言、非纯信息检索、尚未协助过」的回答触发。',
  A2_agent_allfail:
    '多智能体全失败 → 不返回笼统套话,而是抢救各子代理的失败原因/空产出,给出诚实的'
    + '「哪个代理失败、为何失败、下一步建议」;确无任何信息可呈现时才回落套话。',
  A3_idle_continue:
    '空闲超时且无实质内容 → 先走一次 inertialContinuation 续接,仍无果再认输(timeWarning)。',
  A4_language:
    '语言不符已由 gateway 语言纠偏完整覆盖(aiGateway 的 beginLanguageRecoveryRetry / '
    + 'errorType:language_mismatch / final_response 检测 + 跨通道兜底);本模块不重复实现。',
});

// ── A1:缺总结 ────────────────────────────────────────────────────────────
/**
 * 判定一段「无工具」回答是否需要主动补总结。
 * @param {object} opts
 * @param {string}  opts.text          - 已剥离工具调用/执行计划的回答正文
 * @param {boolean} [opts.hadToolCalls]- 本轮是否调过工具(信息字段;工具路径有自己的 closure 守卫)
 * @param {boolean} [opts.isInfoRequest]- 是否纯信息检索类请求(此类无须强加总结)
 * @param {boolean} [opts.alreadyAssisted]- 是否已经为本回合补过一次总结(一次性)
 * @returns {{ assist: boolean, reason: string, detail: (string|null) }}
 *   reason ∈ disabled | info_request | already_assisted | too_short | ok_has_conclusion | missing_summary
 */
function classifySummary(opts = {}) {
  const o = opts || {};
  if (!summaryAssistEnabled()) return { assist: false, reason: 'disabled', detail: null };
  if (o.isInfoRequest) return { assist: false, reason: 'info_request', detail: null };
  if (o.alreadyAssisted) return { assist: false, reason: 'already_assisted', detail: null };
  const clean = String(o.text == null ? '' : o.text).replace(/\s/g, '');
  if (clean.length < SUMMARY_MIN_CHARS) {
    return { assist: false, reason: 'too_short', detail: String(clean.length) };
  }
  if (hasSynthesizedConclusion(o.text)) {
    return { assist: false, reason: 'ok_has_conclusion', detail: null };
  }
  return { assist: true, reason: 'missing_summary', detail: null };
}

/** 主动协助:禁用工具、要模型补一段收尾总结的系统指令。 */
function buildSummaryDirective() {
  return '\n\n[SYSTEM: 你已经完成了主要内容，但回答缺少一个明确的收尾总结/结论。'
    + '请用中文补一段简短的总结或结论（1-3 句即可）：提炼要点或给出明确结果。'
    + '不要重复正文已经写过的内容，不要重新开头或复述问题，不要调用任何工具，直接给出收尾即可。]';
}

/**
 * 被动兜底:模型补总结轮后仍无结论时,服务端合成一句诚实收尾。
 * 仅在「主动协助轮已用尽且模型仍未给结论」时调用;无内容则返回 ''。
 * 注意:此尾巴只追加到 loop 的返回值(惠及 CLI / 非流式 / 历史留存);TUI 流式以
 * 「模型补一轮」为主机制,故服务端尾巴不参与流式渲染(见 plan「风险与权衡」)。
 * @param {string} text
 * @returns {string}
 */
function buildSummaryFallback(text) {
  if (!summaryAssistEnabled()) return '';
  const clean = String(text == null ? '' : text).replace(/\s/g, '');
  if (!clean) return '';
  if (hasSynthesizedConclusion(text)) return ''; // 已有结论,无需兜底(反双渲染)
  return '\n\n---\n**小结**：以上即为本次回答的完整内容，如需就其中任一点展开或继续，请告知。';
}

// ── A2:多智能体全失败 ────────────────────────────────────────────────────
/**
 * 当全部子代理都未产出有效结果时,把各代理的失败原因/空产出抢救成一段诚实说明,
 * 替代笼统套话。确无任何可呈现信息时返回 null(由调用方回落套话)。
 * @param {Array<{name?: string, status?: string, result?: string, detail?: string}>} results
 * @returns {string|null}
 */
function composeAgentAllFailedFallback(results) {
  if (!agentAssistEnabled()) return null;
  const arr = Array.isArray(results) ? results : [];
  const lines = [];
  for (const r of arr) {
    if (!r) continue;
    const name = String(r.name || '子代理').trim();
    const result = String(r.result == null ? '' : r.result).trim();
    if (result.replace(/\s/g, '').length >= SALVAGE_MIN_CHARS) {
      // 极少数:有内容却被上游判为无效——原样抢救出来,标注可能不完整。
      lines.push(`- **${name}**（部分产出，可能不完整）：${result.slice(0, 400)}`);
      continue;
    }
    if (r.status === 'error') {
      const why = String(r.detail || '未知错误').trim().slice(0, 200) || '未知错误';
      lines.push(`- **${name}**：执行失败 — ${why}`);
    } else {
      lines.push(`- **${name}**：返回为空`);
    }
  }
  if (lines.length === 0) return null;
  return '⚠ 本次多个子代理均未能产出有效结果，已为你抢救到以下信息：\n\n'
    + `${lines.join('\n')}\n\n`
    + '建议：1) 用 `/model` 换用更强的模型重试；2) 把任务拆分为更小的步骤；3) 提供更具体的上下文后重发。';
}

// ── A3:空闲超时无内容 ────────────────────────────────────────────────────
/**
 * 空闲超时分支:在认输前是否应先尝试一次续接。仅当「无实质内容且本回合尚未尝试过」时为真。
 * 续接动作本身复用 inertialContinuation(单一真源),本函数只做一次性闸门判定。
 * @param {object} opts
 * @param {boolean} opts.substantive - 是否已收集到实质内容
 * @param {boolean} opts.used        - 本回合是否已尝试过空闲续接
 * @returns {boolean}
 */
function shouldAttemptIdleContinuation(opts = {}) {
  const o = opts || {};
  if (!idleAssistEnabled()) return false;
  if (o.used) return false;       // 一次性,绝不死循环
  if (o.substantive) return false; // 已有内容 → 直接返回即可,无须续接
  return true;
}

module.exports = {
  isEnabled,
  summaryAssistEnabled,
  agentAssistEnabled,
  idleAssistEnabled,
  hasSynthesizedConclusion,
  classifySummary,
  buildSummaryDirective,
  buildSummaryFallback,
  composeAgentAllFailedFallback,
  shouldAttemptIdleContinuation,
  RULES,
  MASTER_FLAG,
  SUMMARY_FLAG,
  AGENT_FLAG,
  IDLE_FLAG,
  SUMMARY_MIN_CHARS,
};
