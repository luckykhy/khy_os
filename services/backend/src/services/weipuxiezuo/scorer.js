'use strict';

/**
 * weipuxiezuo/scorer.js — 三维评分（确定性公式，纯函数）。
 *
 * 对应 skill 文档「Step 4：评分输出」的三维评分报告，但把「让模型自己估分」换成
 * 可复算的公式：同一段文本，分数恒定、可回归、可解释。三个维度：
 *   - aigc      AIGC 痕迹分（越低越好，≤40 合格）：模式命中密度 + 节奏均一度 + 加粗滥用
 *   - academic  学术质量分（越高越好，≥55 合格）：引用 + 具体性 + 节奏 + 句长 + 学者语气
 *   - citation  引用与化用：显式引用篇数 + 化用密度
 *
 * 公式刻意保守且对「干净的人类学术文」给高分、对「AI 模板文」给低分；阈值与权重
 * 集中在 rules.thresholds，可经环境变量调档。分数不是真理，是**可优化的度量**——
 * 这正是把方法论变成代码的意义（对照 contextDiagnostics）。
 */

const rules = require('./rules');

function _clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// AIGC：每句加权命中 → 分数的放大系数（perSentence≈3 时接近上限）。
const AIGC_HIT_K = 24;
const AIGC_HIT_CAP = 75;
// 节奏均一阈值：CV 低于此值开始计入 AI 痕迹。
const RHYTHM_CV_FLOOR = 0.45;
const RHYTHM_MAX_PENALTY = 18;
// 句子太少时 CV 无统计意义（空文本/单句不应被判 AI 节奏），低于此句数不计节奏项。
const RHYTHM_MIN_SENTENCES = 3;

/**
 * @param {object} detection - detector.detect() 的返回
 * @returns {{
 *   aigc: { score:number, pass:boolean, components:object },
 *   academic: { score:number, pass:boolean, components:object },
 *   citation: { explicit:number, distinct:number, huayongMarkers:number, huayongPct:number },
 *   verdict: { allPass:boolean, failed:string[] },
 * }}
 */
function score(detection) {
  const { stats, totals } = detection;
  const { thresholds } = rules;
  const sentences = Math.max(1, stats.sentenceCount);
  const cv = stats.rhythm.cv || 0;

  // ── AIGC 分（越低越好）──
  const rhythmMeaningful = stats.sentenceCount >= RHYTHM_MIN_SENTENCES;
  const perSentence = totals.weighted / sentences;
  const hitScore = Math.min(AIGC_HIT_CAP, perSentence * AIGC_HIT_K);
  const rhythmPenalty = rhythmMeaningful && cv < RHYTHM_CV_FLOOR
    ? _clamp((RHYTHM_CV_FLOOR - cv) / RHYTHM_CV_FLOOR * RHYTHM_MAX_PENALTY, 0, RHYTHM_MAX_PENALTY)
    : 0;
  const boldPenalty = stats.boldCount > thresholds.boldTotal
    ? Math.min(10, (stats.boldCount - thresholds.boldTotal) * 2)
    : 0;
  const aigcScore = Math.round(_clamp(hitScore + rhythmPenalty + boldPenalty, 0, 100));

  // ── 学术质量分（越高越好）──
  const base = 25;
  const citationComponent = Math.min(25, stats.explicitCitations * 3 + stats.huayongMarkers * 3);
  // 句子太少 → 节奏不可判，给中性分（既不奖也不罚短片段）。
  const rhythmGood = !rhythmMeaningful
    ? 12
    : (cv >= RHYTHM_CV_FLOOR ? 18 : _clamp(cv / RHYTHM_CV_FLOOR * 18, 0, 18));
  const specificity = Math.min(18, (stats.yearCount + stats.numberUnitCount) * 4);
  const avgLen = stats.rhythm.mean || 0;
  const lengthGood = avgLen >= 18 && avgLen <= 75 ? 14 : _clamp(14 - Math.abs(avgLen - 46) / 6, 0, 14);
  // 学者语气（「无魂写作」反向信号）：中性语气/主观判断词加分。
  const neutralRe = rules.neutralToneRegex();
  neutralRe.lastIndex = 0;
  let neutralHits = 0;
  // detector 只给 stats；这里用原始度量不可得，改由调用方传文本时计算。回退 0。
  if (detection.text) {
    let m;
    while ((m = neutralRe.exec(detection.text)) !== null) neutralHits += 1;
  }
  const voiceBonus = Math.min(6, neutralHits * 2);
  // 口语红线扣分
  let colloquialHits = 0;
  if (detection.text) {
    const cre = rules.colloquialRegex();
    cre.lastIndex = 0;
    let m;
    while ((m = cre.exec(detection.text)) !== null) colloquialHits += 1;
  }
  const colloquialPenalty = colloquialHits * 8;
  const academicScore = Math.round(
    _clamp(base + citationComponent + rhythmGood + specificity + lengthGood + voiceBonus - colloquialPenalty, 0, 100)
  );

  // ── 引用与化用 ──
  const huayongPct = stats.huayongMarkers / sentences;

  const aigc = {
    score: aigcScore,
    pass: aigcScore <= thresholds.aigcPass,
    components: { hitScore: Math.round(hitScore), rhythmPenalty: Math.round(rhythmPenalty), boldPenalty },
  };
  const academic = {
    score: academicScore,
    pass: academicScore >= thresholds.academicPass,
    components: {
      base, citationComponent, rhythmGood: Math.round(rhythmGood), specificity,
      lengthGood: Math.round(lengthGood), voiceBonus, colloquialPenalty,
    },
  };
  const citation = {
    explicit: stats.explicitCitations,
    distinct: stats.distinctCitationNumbers,
    huayongMarkers: stats.huayongMarkers,
    huayongPct: Math.round(huayongPct * 1000) / 1000,
  };

  const failed = [];
  if (!aigc.pass) failed.push('aigc');
  if (!academic.pass) failed.push('academic');

  return { aigc, academic, citation, verdict: { allPass: failed.length === 0, failed } };
}

module.exports = { score };
