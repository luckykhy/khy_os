'use strict';

/**
 * searchConvergence.js — 「搜索循环 → 主动收敛 + 被动兜底」的单一真源。
 *
 * Goal (2026-06-25): 「Khyos 可以准确地搜索外部信息」。真实失败轨迹:弱模型被问一个
 * 知识补全题后,连续发起 15+ 次 web_search/WebFetch(每次 query 略有不同),每轮都重复
 * 同一句旁白「我先补一下外部信息…再回来收口」,却从不进入综合作答,最终超时才被迫收尾。
 *
 * 根因:现有所有防线都漏接了这种「换词搜索、成功却不收口」的循环 ——
 *   - circuitBreaker 阈值 50 次,远高于本案的 ~15 次;
 *   - genericRepeat 的 hash 含 query 串,换词即 hash 不同,永不计数;
 *   - extractSearchIntent 去重只折叠完全相同的关键词集;
 *   - consecutiveReadOnlyIterations 只软提示后清零,从不强制作答;
 *   - forced-summary 收尾轮要求模型「回空」,但模型一直吐旁白填充,从不回空。
 * 于是只剩 timeout 能终止 —— 正是用户抱怨的「无限递归没有结果强制总结才开始」。
 *
 * 本模块把「搜索循环」也纳入「主动协助」:连续 N 轮「纯搜索且未综合」且已有结果时,
 * 主动判定「该收敛了」,由 toolUseLoop 接缝强制一轮禁工具的综合作答(基于已检索到的内容),
 * 而非放任到超时。设计同 activeAssist.js / inertialContinuation.js:纯叶子、env 门控
 * (默认开)、冻结 RULES、只做判定 + 给指令文案,绝不发起模型调用、绝不渲染;
 * 任何 throw → fail-soft 回落今天行为。收敛是一次性(alreadyForced),强制后仍不收口
 * 则自然回落既有 forced-summary / timeout 链,绝不死循环。
 */

const MASTER_FLAG = 'KHY_SEARCH_CONVERGENCE';
const ROUND_CAP_FLAG = 'KHY_SEARCH_ROUND_CAP';

// 连续 N 轮「纯搜索且未综合」即强制收敛。默认 3:足够补齐外部事实,又远低于
// circuitBreaker 的 50,在「绕圈子」演变成超时之前就主动收口。
const DEFAULT_ROUND_CAP = 3;

/**
 * env 门控惯例(同 activeAssist.flagOn):默认开,仅显式 0/false/off/no 关。
 * @param {string} flag
 * @returns {boolean}
 */
function flagOn(flag) {
  const v = String(process.env[flag] == null ? '' : process.env[flag]).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 主闸。 */
function isEnabled() { return flagOn(MASTER_FLAG); }

/** 连续纯搜索轮上限(可经 KHY_SEARCH_ROUND_CAP 调整,非法值回落默认)。 */
function roundCap() {
  const n = parseInt(process.env[ROUND_CAP_FLAG], 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ROUND_CAP;
}

// ── RULES:何时主动收敛 / 何时不(冻结,文档即契约)───────────────────────────
const RULES = Object.freeze({
  S1_converge_after_n:
    '连续 N 轮(KHY_SEARCH_ROUND_CAP,默认 3)都是「纯外部搜索/抓取且未综合作答」且已检索到结果时,'
    + '主动强制一轮禁用工具的收敛作答(一次性),不放任循环到超时。',
  S2_synthesize_gathered:
    '收敛轮必须基于已检索到的结果直接作答,信息不足处明确标注「未能确证」,本轮不得再发起搜索/抓取。',
  S3_baidu_real_url:
    '提升准确度:百度结果链接应还原为真实 URL(详见 webSearchService._baiduRealUrl),'
    + '让模型看到真实站点、减少为每个 /link? 跳转桩额外 WebFetch —— 那些多余抓取会反向喂大本循环。',
});

/**
 * 判定一段「连续纯搜索」是否到了该主动收敛的程度。
 * @param {object} opts
 * @param {number} opts.searchRounds     - 连续「纯搜索且未综合」的轮数
 * @param {number} opts.resultsGathered  - 累计已成功检索到的 web-lookup 条目数
 * @param {boolean} [opts.alreadyForced] - 本回合是否已强制过一次收敛(一次性)
 * @returns {{ converge: boolean, reason: string, detail: (number|null) }}
 *   reason ∈ disabled | already_forced | no_results | below_cap | converge_now
 *   detail = converge 时为命中的轮数,否则为 null
 */
function classifySearchLoop(opts = {}) {
  const o = opts || {};
  if (!isEnabled()) return { converge: false, reason: 'disabled', detail: null };
  if (o.alreadyForced) return { converge: false, reason: 'already_forced', detail: null };
  const rounds = Number(o.searchRounds) || 0;
  const gathered = Number(o.resultsGathered) || 0;
  if (gathered <= 0) return { converge: false, reason: 'no_results', detail: null };
  if (rounds < roundCap()) return { converge: false, reason: 'below_cap', detail: null };
  return { converge: true, reason: 'converge_now', detail: rounds };
}

/**
 * 主动协助:禁用工具、要求模型基于已检索结果直接综合作答的系统指令。
 * @param {object} [opts]
 * @param {number} [opts.searchRounds]    - 已做的搜索轮数(用于措辞,缺省不显示数字)
 * @param {number} [opts.resultsGathered] - 累计结果条数(用于措辞)
 * @returns {string}
 */
function buildConvergenceDirective(opts = {}) {
  const o = opts || {};
  const rounds = Number(o.searchRounds) || 0;
  const gathered = Number(o.resultsGathered) || 0;
  const stat = (rounds > 0 || gathered > 0)
    ? `你已做了 ${rounds || '多'} 次外部搜索、累计约 ${gathered || '若干'} 条结果（见上方工具结果）。`
    : '你已做了多轮外部搜索（见上方工具结果）。';
  return '\n\n[SYSTEM: ' + stat
    + '现在请停止继续搜索——本轮禁止再调用任何工具（不要再 web_search / 不要再 WebFetch）。'
    + '请直接基于已经检索到的内容，用中文给出一份完整、结构化的最终答案；'
    + '对仍未查到或无法确证的点，明确标注「未能确证」即可，不要为此再发起搜索或抓取。]';
}

module.exports = {
  isEnabled,
  roundCap,
  classifySearchLoop,
  buildConvergenceDirective,
  RULES,
  MASTER_FLAG,
  ROUND_CAP_FLAG,
  DEFAULT_ROUND_CAP,
};
