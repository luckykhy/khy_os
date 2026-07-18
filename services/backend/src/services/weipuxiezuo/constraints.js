'use strict';

/**
 * weipuxiezuo/constraints.js — 强制硬约束闸（确定性判合格，纯函数）。
 *
 * 对应 skill 文档「五、强制硬约束」表。把每条上限变成 {key,label,limit,actual,pass}，
 * 由代码判定通过/不通过——这是「闸」，不是「建议」：模型改完，代码说了算。
 *
 * mode（fragment|chapter|full）影响引用类约束：
 *   - full     全文：显式引用恰好 15 篇，编号递增
 *   - chapter  章节：引用接续，不强制 15 篇
 *   - fragment 片段：1-2 处角标正常，不判引用不足（文档明确）
 *
 * 「编造文献 = 0」无法由代码判真伪，归为 advisory（标 [待核实] 的需人工/联网核实）。
 */

const rules = require('./rules');
const textStats = require('./textStats');

/**
 * @param {object} detection - detector.detect() 返回
 * @param {object} [opts]
 * @param {'fragment'|'chapter'|'full'} [opts.mode='fragment']
 * @returns {{ items: Array<{key,label,limit,actual,pass,advisory?:boolean,note?:string}>, pass: boolean, failedKeys: string[] }}
 */
function check(detection, opts = {}) {
  const mode = opts.mode || 'fragment';
  const { thresholds } = rules;
  const { stats, totals } = detection;
  const items = [];

  const add = (key, label, limit, actual, pass, extra = {}) =>
    items.push({ key, label, limit, actual, pass, ...extra });

  // AI 高频词/段 ≤ 2
  add('highFreqPerPara', 'AI高频词/段', `≤${thresholds.highFreqPerParagraph}`,
    totals.maxHighFreqPerPara, totals.maxHighFreqPerPara <= thresholds.highFreqPerParagraph);

  // 段末总结套句 全文 ≤ 1
  add('endCliche', '段末套句(全文)', `≤${thresholds.endClicheTotal}`,
    totals.endCliche, totals.endCliche <= thresholds.endClicheTotal);

  // 三元并列/段 ≤ 1
  add('tripletPerPara', '三元并列/段', `≤${thresholds.tripletPerParagraph}`,
    totals.tripletMax, totals.tripletMax <= thresholds.tripletPerParagraph);

  // 理论起笔段落 ≤ 20%
  const theoryPct = Math.round(totals.theoryOpenerRatio * 100);
  add('theoryOpener', '理论起笔段落', `≤${Math.round(thresholds.theoryOpenerRatio * 100)}%`,
    `${theoryPct}%`, totals.theoryOpenerRatio <= thresholds.theoryOpenerRatio + 1e-9);

  // 正文加粗 ≤ 5
  add('bold', '正文加粗', `≤${thresholds.boldTotal}`,
    stats.boldCount, stats.boldCount <= thresholds.boldTotal);

  // 泛化结尾 = 0（模式 10）
  const generalEnding = (detection.findings.find((f) => f.id === 10) || { count: 0 }).count;
  add('generalEnding', '泛化结尾', '=0', generalEnding, generalEnding === 0);

  // 模糊归因 = 0（模式 8，已排除有出处的）
  const vague = (detection.findings.find((f) => f.id === 8) || { count: 0 }).count;
  add('vagueAttribution', '模糊归因', '=0', vague, vague === 0);

  // 化用密度 20%-40%
  const huayongPct = stats.sentenceCount ? stats.huayongMarkers / stats.sentenceCount : 0;
  const huayongOk = huayongPct >= thresholds.huayongMin && huayongPct <= thresholds.huayongMax;
  add('huayong', '化用密度', `${Math.round(thresholds.huayongMin * 100)}%-${Math.round(thresholds.huayongMax * 100)}%`,
    `${Math.round(huayongPct * 100)}%`, huayongOk,
    // 片段模式下化用密度仅作参考，不计入硬失败
    mode === 'fragment' ? { advisory: true, note: '片段模式化用密度仅供参考' } : {});

  // 显式引用（mode 相关）
  if (mode === 'full') {
    const target = thresholds.explicitCitationFull;
    const ascending = _isStrictlyAscending(stats.citationNumbers);
    add('citationCount', '显式引用篇数', `=${target}`,
      stats.distinctCitationNumbers, stats.distinctCitationNumbers === target);
    add('citationAscending', '引用编号递增', '严格递增', ascending ? '是' : '否', ascending);
  } else if (mode === 'chapter') {
    add('citationCount', '显式引用篇数', '≥1(接续)', stats.distinctCitationNumbers,
      stats.distinctCitationNumbers >= 1, { advisory: true });
  } else {
    add('citationCount', '显式引用(片段)', '1-2 正常', stats.explicitCitations, true,
      { advisory: true, note: '片段 1-2 处角标正常，不判不足' });
  }

  // 编造文献 = 0（无法代码判真伪 → advisory，统计 [待核实] 标记数）
  const toVerify = _countToVerify(detection.text || '');
  add('fabrication', '编造文献([待核实])', '人工/联网核实', toVerify, toVerify === 0,
    { advisory: true, note: '代码无法判真伪，[待核实] 需 WebSearch 或人工确认' });

  const hardFailures = items.filter((it) => !it.pass && !it.advisory);
  return {
    items,
    pass: hardFailures.length === 0,
    failedKeys: hardFailures.map((it) => it.key),
  };
}

function _isStrictlyAscending(nums) {
  for (let i = 1; i < nums.length; i += 1) {
    if (nums[i] <= nums[i - 1]) return false;
  }
  return true;
}

function _countToVerify(text) {
  const m = String(text || '').match(/\[待核实\]/g);
  return m ? m.length : 0;
}

module.exports = { check };
