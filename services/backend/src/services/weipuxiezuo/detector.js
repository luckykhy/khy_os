'use strict';

/**
 * weipuxiezuo/detector.js — 16 种 AI 写作模式的确定性检测器（纯函数）。
 *
 * 把 rules.js 声明的模式落到具体文本上：逐段扫描、定位每一处命中、记录在第几段、
 * 是否落在段末（套句类），并对「模糊归因」做邻近引用核查（有真实出处就不算 AI 痕迹）。
 * 同时产出 detector 级聚合（每段 AI 高频词数、每段冒号/破折号数、理论起笔段落比例），
 * 供 constraints 直接判合格，无需重算。
 *
 * 返回的 findings 是**带位置的结构化清单**——这就是喂给模型的「修复任务」，
 * 取代原 skill 里那段「教模型认 16 种模式」的提示词。
 */

const rules = require('./rules');
const textStats = require('./textStats');

/**
 * 判断在段落 paraText 内、局部偏移 localIdx 处的命中是否「靠近段末」。
 * 规则：命中点到段末的剩余自然长度 ≤ max(40, 段长*0.45) 即视为段末套句。
 */
function _isNearEnd(paraText, localIdx, matchLen) {
  const tail = paraText.slice(localIdx + matchLen);
  const tailLen = textStats.naturalLength(tail);
  const paraLen = textStats.naturalLength(paraText);
  return tailLen <= Math.max(40, paraLen * 0.45);
}

/**
 * 模糊归因核查：命中点 ±window 字符内是否存在真实引用（<sup>[n]</sup> / 年份标记）。
 * 有出处 → 不是模糊归因（return true 表示「已被引用支撑」）。
 */
function _hasNearbyCitation(text, idx, window = 60) {
  const from = Math.max(0, idx - window);
  const slice = text.slice(from, idx + window);
  return (
    /<sup>\s*\[\s*\d+\s*\]\s*<\/sup>/.test(slice) ||
    /\[\s*\d{1,3}\s*\]/.test(slice) ||
    textStats.CITATION_YEAR.test(slice)
  );
}

/**
 * 主检测。
 * @param {string} text
 * @returns {{
 *   findings: Array<{id,name,priority,fix,count,matches:Array<{text,index,paragraph,atEnd}>}>,
 *   stats: object,
 *   perParagraph: Array<{ index, highFreq, colons, dashes, theoryOpener }>,
 *   totals: { high, mid, low, weighted, theoryOpenerRatio, maxHighFreqPerPara, endCliche, tripletMax },
 * }}
 */
function detect(text) {
  const src = String(text || '');
  const stats = textStats.compute(src);
  const paras = textStats.paragraphsWithOffsets(src);
  const patterns = rules.compiledPatterns();
  const { thresholds } = rules;

  // id -> finding（聚合所有段的命中）
  const byId = new Map();
  const ensure = (p) => {
    if (!byId.has(p.id)) {
      byId.set(p.id, { id: p.id, name: p.name, priority: p.priority, fix: p.fix, count: 0, matches: [] });
    }
    return byId.get(p.id);
  };

  const perParagraph = [];
  let theoryOpenerParas = 0;
  let maxHighFreqPerPara = 0;
  let tripletMax = 0;

  for (let pi = 0; pi < paras.length; pi += 1) {
    const para = paras[pi];
    const ptext = para.text;

    // ── 逐模式（带 regex 的）在本段内定位 ──
    let tripletInPara = 0;
    for (const pat of patterns) {
      if (!pat.re) continue; // 15/16 段级/全文级，单独处理
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(ptext)) !== null) {
        const localIdx = m.index;
        const matchStr = m[0];
        const globalIdx = para.start + localIdx;

        if (pat.atEnd && !_isNearEnd(ptext, localIdx, matchStr.length)) continue;
        if (pat.requiresNoCitation && _hasNearbyCitation(src, globalIdx)) continue;

        const f = ensure(pat);
        f.count += 1;
        f.matches.push({ text: matchStr, index: globalIdx, paragraph: pi, atEnd: !!pat.atEnd });
        if (pat.id === 6) tripletInPara += 1;

        if (matchStr.length === 0) pat.re.lastIndex += 1; // 防零宽死循环
      }
    }
    if (tripletInPara > tripletMax) tripletMax = tripletInPara;

    // ── 理论起笔：本段第一句是否命中模式 1 ──
    const firstSentence = textStats.sentences(ptext)[0] || '';
    const theoryRe = patterns.find((p) => p.id === 1).re;
    theoryRe.lastIndex = 0;
    const theoryOpener = theoryRe.test(firstSentence);
    if (theoryOpener) theoryOpenerParas += 1;

    // ── 每段 AI 高频词数（约束「每段≤2」）──
    const hf = rules.highFreqRegex();
    hf.lastIndex = 0;
    let highFreq = 0;
    let hfm;
    while ((hfm = hf.exec(ptext)) !== null) {
      highFreq += 1;
      const f = ensure({ id: 11, name: 'AI高频词', priority: rules.PRIORITY.HIGH, fix: rules.PATTERNS[10].fix });
      f.matches.push({ text: hfm[0], index: para.start + hfm.index, paragraph: pi, atEnd: false });
      f.count += 1;
    }
    if (highFreq > maxHighFreqPerPara) maxHighFreqPerPara = highFreq;

    // ── 标点失衡（模式 15，段级）──
    const colons = (ptext.match(/[:：]/g) || []).length;
    const dashes = (ptext.match(/——|--/g) || []).length;
    if (colons >= thresholds.colonPerParagraph || dashes >= thresholds.dashPerParagraph) {
      const f = ensure({ id: 15, name: '标点失衡', priority: rules.PRIORITY.LOW, fix: rules.PATTERNS[14].fix });
      f.count += 1;
      f.matches.push({ text: `冒号${colons}/破折号${dashes}`, index: para.start, paragraph: pi, atEnd: false });
    }

    perParagraph.push({ index: pi, highFreq, colons, dashes, theoryOpener });
  }

  // ── 加粗滥用（模式 16，全文级）──
  if (stats.boldCount > thresholds.boldTotal) {
    const f = ensure({ id: 16, name: '加粗滥用', priority: rules.PRIORITY.LOW, fix: rules.PATTERNS[15].fix });
    f.count = stats.boldCount;
    f.matches.push({ text: `全文加粗 ${stats.boldCount} 处`, index: 0, paragraph: -1, atEnd: false });
  }

  const findings = [...byId.values()].sort((a, b) => a.id - b.id);

  // 权重：high=3 / mid=2 / low=1（按文档优先级，驱动 AIGC 评分）
  const W = { [rules.PRIORITY.HIGH]: 3, [rules.PRIORITY.MID]: 2, [rules.PRIORITY.LOW]: 1 };
  let high = 0;
  let mid = 0;
  let low = 0;
  let weighted = 0;
  for (const f of findings) {
    if (f.priority === rules.PRIORITY.HIGH) high += f.count;
    else if (f.priority === rules.PRIORITY.MID) mid += f.count;
    else low += f.count;
    weighted += (W[f.priority] || 1) * f.count;
  }

  // 段末套句总数（模式 2 + 7）
  const endCliche = findings
    .filter((f) => f.id === 2 || f.id === 7)
    .reduce((a, f) => a + f.count, 0);

  return {
    findings,
    stats,
    perParagraph,
    totals: {
      high,
      mid,
      low,
      weighted,
      theoryOpenerRatio: paras.length ? theoryOpenerParas / paras.length : 0,
      maxHighFreqPerPara,
      endCliche,
      tripletMax,
    },
  };
}

module.exports = { detect, _isNearEnd, _hasNearbyCitation };
