'use strict';

/**
 * searchAdversarialVerifier.js — 搜索结果对抗式核验纯叶子(goal 2026-09-05
 * 「对抗式核验:提高有效信息获取效率」)。
 *
 * 上一阶段的 searchQualityEnhancer 解决了「单条结果质量」问题,但搜索系统仍面临
 * 更隐蔽的威胁:付费推广混入、SEO 操纵、信息茧房、跨引擎一致性不足。
 * 本叶子从「对抗」视角补齐三道防线:
 *
 *   1. 跨引擎一致性核验(Cross-Engine Consistency)
 *      - 多引擎返回结果是否指向同一事实共识?
 *      - 单一引擎独有源 vs 多引擎共识源的可信度差异
 *      - 检测「信息茧房」:所有引擎返回同一批站点(同质化)
 *
 *   2. 付费推广 / SEO 操纵检测(Paid Promotion & SEO Spam Detection)
 *      - 标题/摘要中的推广信号(「广告」「推广」「赞助」标记缺失时的隐式推广)
 *      - 商业意图密度(品牌词堆砌、CTA 模式)
 *      - SEO 操纵特征(关键词堆砌、门页特征)
 *
 *   3. 置信度评分(Confidence Scoring)
 *      - 综合「跨引擎共识 + 来源多样性 + 质量分 + 对抗信号」
 *      - 输出 0~1 置信度 + 风险标签 + 建议核验方向
 *
 * 设计原则(与 searchQualityEnhancer / searchSourceDiscovery 一脉相承):
 *   - 纯叶子:零 IO、确定性、绝不抛(输入强转)
 *   - 不丢结果:核验信号用于标注/置信度,不删除结果
 *   - 可配置:阈值、权重一律走 env(KHY_ADVERSARIAL_*)
 */

const { tokenizeForSearch } = require('../../../searchTokenizer');

// ── env 工具 ─────────────────────────────────────────────────────────

function _float(envName, fallback, min, max) {
  const raw = parseFloat(String(process.env[envName] || ''));
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

function _int(envName, fallback, min, max) {
  const raw = parseInt(String(process.env[envName] || ''), 10);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

// ── 1. 跨引擎一致性核验 ─────────────────────────────────────────────

/**
 * 计算结果集合的来源多样性分数。
 * 高多样性 = 多个独立站点/域名;低多样性 = 同质化(可能信息茧房)。
 *
 * 使用 Simpson's Diversity Index 的简化版:
 *   diversity = 1 - Σ(n_i / N)^2
 *   其中 n_i 是域名 i 的结果数,N 是总结果数
 *   → 全部来自同一域名 → 0;每个结果不同域名 → 1
 *
 * @param {object[]} results  含 domain 字段的结果
 * @returns {number} 0(完全同质) ~ 1(完全多样)
 */
function sourceDiversity(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return 0;
  }
  const domainCounts = new Map();
  let total = 0;
  for (const r of results) {
    const d = String((r && (r.domain || r.url)) || '').toLowerCase();
    if (!d) {
      continue;
    }
    // 从 URL 提取域名(若无 domain 字段)
    const host = d.startsWith('http') ? _extractHost(d) : d;
    if (!host) {
      continue;
    }
    domainCounts.set(host, (domainCounts.get(host) || 0) + 1);
    total += 1;
  }
  if (total <= 1) {
    return total === 1 ? 0.5 : 0; // 单条结果多样性中性
  }
  let sumSquares = 0;
  for (const count of domainCounts.values()) {
    const p = count / total;
    sumSquares += p * p;
  }
  return Math.max(0, Math.min(1, 1 - sumSquares));
}

/**
 * 计算跨引擎共识度:被 ≥2 引擎收录的结果占比。
 * 高共识度 → 结果更可信;低共识度 → 可能含大量噪声/独有源。
 *
 * @param {object[]} results  含 engineCount 字段
 * @returns {number} 0(无共识) ~ 1(全部共识)
 */
function crossEngineConsensus(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return 0;
  }
  let consensusCount = 0;
  for (const r of results) {
    const ec = Number.isFinite(r && r.engineCount) ? r.engineCount : 1;
    if (ec >= 2) {
      consensusCount += 1;
    }
  }
  return consensusCount / results.length;
}

/**
 * 检测「信息茧房」风险:结果是否过度集中在少数站点。
 * 返回风险等级 'low' | 'medium' | 'high'。
 *
 * @param {object[]} results
 * @returns {'low'|'medium'|'high'}
 */
function filterBubbleRisk(results) {
  if (!Array.isArray(results) || results.length < 3) {
    return 'low';
  }
  const diversity = sourceDiversity(results);
  const consensus = crossEngineConsensus(results);
  // 低多样性 + 低共识 → 高风险(每个引擎各说各话,且来源集中)
  // 低多样性 + 高共识 → 中风险(来源集中但共识强,可能是权威源主导)
  if (diversity < 0.3 && consensus < 0.3) {
    return 'high';
  }
  if (diversity < 0.5 || consensus < 0.2) {
    return 'medium';
  }
  return 'low';
}

// ── 2. 付费推广 / SEO 操纵检测 ───────────────────────────────────────

const _PROMO_PATTERNS = [
  /广告$/,
  /推广$/,
  /赞助$/,
  / sponsored/i,
  /广告主/i,
  /品牌主/i,
  /热销/i,
  /爆款/i,
  /限时/i,
  /特价/i,
  /折扣$/,
  /优惠$/,
  /购买$/,
  /下单$/,
  /立即购买/i,
  /点击购买/i,
  /免费试用/i,
  /领取优惠/i,
  /领券/i,
  /满减/i,
  /包邮/i,
  /正品/i,
  /官方旗舰店/i,
  /直营$/,
  /加盟$/,
  /代理$/,
  /招商$/,
];

const _CTA_PATTERNS = [
  /立即(购买|下单|领取|点击)/,
  /点击(查看|了解|这里|链接)/,
  /扫码(领取|购买|关注)/,
  /添加(微信|客服|好友)/,
  /拨打(电话|热线)/,
  /咨询(客服|我们)/,
  /了解更多/,
  /查看详情/,
  /马上(开始|体验|注册)/,
  /免费(领取|获取|下载|试用)/,
  /限时(免费|领取|体验)/,
  /click\s+(here|now|below)/i,
  /buy\s+now/i,
  /shop\s+now/i,
  /get\s+started/i,
  /sign\s+up\s+now/i,
  /try\s+free/i,
  /download\s+now/i,
];

const _SEO_SPAM_PATTERNS = [
  /关键词(优化|推广|排名|霸屏)/,
  /SEO(优化|推广|排名)/,
  /SEM(推广|优化)/,
  /全网(推广|营销|覆盖)/,
  /一站式(服务|解决方案)/,
  /专业(代写|代发|代做)/,
  /包过/i,
  /包上/i,
  /保证(排名|收录)/,
  /快速(排名|收录|上首页)/,
];

/**
 * 检测标题/摘要中的付费推广信号。返回 0(无) ~ 1(高度疑似推广)。
 * @param {string} title
 * @param {string} snippet
 * @returns {number}
 */
function paidPromotionScore(title, snippet) {
  const text = `${title || ''} ${snippet || ''}`.trim();
  if (!text) {
    return 0;
  }
  let score = 0;
  for (const p of _PROMO_PATTERNS) {
    if (p.test(text)) {
      score += 0.2;
      break; // 推广信号只计一次
    }
  }
  let ctaCount = 0;
  for (const p of _CTA_PATTERNS) {
    if (p.test(text)) {
      ctaCount += 1;
    }
  }
  score += Math.min(ctaCount * 0.15, 0.4); // CTA 最多贡献 0.4
  return Math.min(score, 1);
}

/**
 * 检测 SEO 操纵 / 门页特征。返回 0(无) ~ 1(高度疑似 SEO 操纵)。
 * @param {string} title
 * @param {string} snippet
 * @param {string} url
 * @returns {number}
 */
function seoSpamScore(title, snippet, url) {
  const text = `${title || ''} ${snippet || ''}`.trim();
  if (!text) {
    return 0;
  }
  let score = 0;
  for (const p of _SEO_SPAM_PATTERNS) {
    if (p.test(text)) {
      score += 0.3;
      break;
    }
  }
  // 标题关键词堆砌:重复词 ≥3 次
  const words = text.split(/\s+/);
  const wordCounts = new Map();
  for (const w of words) {
    if (w.length >= 2) {
      wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
    }
  }
  for (const count of wordCounts.values()) {
    if (count >= 3) {
      score += 0.2;
      break;
    }
  }
  // URL 含 SEO 常见路径特征
  const urlLower = String(url || '').toLowerCase();
  if (/seo|sem|youhua|tui[gu]an|keyrank|backlink/.test(urlLower)) {
    score += 0.2;
  }
  return Math.min(score, 1);
}

// ── 3. 置信度评分 ───────────────────────────────────────────────────

/**
 * 对单条结果计算置信度分数。
 *
 * 置信度 = baseConfidence
 *         + consensusBonus(跨引擎共识奖励)
 *         + diversityBonus(来源多样性奖励)
 *         - promoPenalty(推广惩罚)
 *         - spamPenalty(SEO 操纵惩罚)
 *         - qualityRiskPenalty(质量风险惩罚)
 *
 * @param {object} result    { title, url, snippet, engineCount?, domain?, _quality? }
 * @param {object} opts
 * @param {number} opts.sourceDiversity  来源多样性分数
 * @param {number} opts.crossConsensus   跨引擎共识度
 * @param {number} opts.now              Date.now()
 * @returns {{ confidence:number, riskLevel:'low'|'medium'|'high', flags:string[], suggestions:string[] }}
 */
function confidenceScore(result, opts = {}) {
  const {
    sourceDiversity: div = 0.5,
    crossConsensus: consensus = 0.3,
    now = Date.now(),
  } = opts;
  const r = result || {};
  const flags = [];
  const suggestions = [];

  // 基础置信度:来自质量分(若有)
  let base = 0.5;
  if (r._quality && Number.isFinite(r._quality.total)) {
    base = r._quality.total;
  }

  // 跨引擎共识奖励
  const ec = Number.isFinite(r.engineCount) ? r.engineCount : 1;
  let consensusBonus = 0;
  if (ec >= 3) {
    consensusBonus = 0.2;
    flags.push('strong-consensus');
  } else if (ec === 2) {
    consensusBonus = 0.1;
    flags.push('consensus');
  } else {
    flags.push('single-source');
    suggestions.push('该结果仅单一来源,建议交叉验证');
  }

  // 来源多样性奖励(全局信号,非单条)
  const diversityBonus = div >= 0.7 ? 0.05 : div < 0.3 ? -0.1 : 0;
  if (div < 0.3) {
    flags.push('low-diversity');
  }

  // 推广惩罚
  const promo = paidPromotionScore(r.title, r.snippet);
  const promoPenalty = promo * _float('KHY_ADVERSARIAL_PROMO_PENALTY', 0.4, 0, 1);
  if (promo >= 0.3) {
    flags.push('paid-promo');
    suggestions.push('疑似付费推广内容,注意甄别商业意图');
  }

  // SEO 操纵惩罚
  const spam = seoSpamScore(r.title, r.snippet, r.url);
  const spamPenalty = spam * _float('KHY_ADVERSARIAL_SPAM_PENALTY', 0.5, 0, 1);
  if (spam >= 0.3) {
    flags.push('seo-spam');
    suggestions.push('疑似 SEO 操纵内容,可信度较低');
  }

  // 质量风险惩罚(来自 quality enhancer 的 flags)
  if (Array.isArray(r._quality) && r._quality.flags) {
    if (r._quality.flags.includes('clickbait')) {
      flags.push('clickbait-risk');
    }
    if (r._quality.flags.includes('thin')) {
      flags.push('thin-content');
    }
    if (r._quality.flags.includes('linkfarm')) {
      flags.push('linkfarm-risk');
    }
  }

  const confidence = Math.max(0, Math.min(1, base + consensusBonus + diversityBonus - promoPenalty - spamPenalty));

  // 风险等级
  let riskLevel = 'low';
  if (confidence < 0.3 || promo >= 0.5 || spam >= 0.5) {
    riskLevel = 'high';
  } else if (confidence < 0.5 || promo >= 0.3 || spam >= 0.3) {
    riskLevel = 'medium';
  }

  return {
    confidence: Math.round(confidence * 1000) / 1000,
    riskLevel,
    flags,
    suggestions,
  };
}

// ── 4. 批量核验 ─────────────────────────────────────────────────────

/**
 * 对结果列表做对抗式核验,附加置信度 + 风险标注。
 *
 * @param {object[]} results  已质量重排的结果(含 _quality)
 * @returns {object[]} 核验后结果(附加 _confidence 字段)
 */
function verifyResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return results || [];
  }
  const div = sourceDiversity(results);
  const consensus = crossEngineConsensus(results);
  const bubbleRisk = filterBubbleRisk(results);

  return results.map((r, idx) => {
    const conf = confidenceScore(r, {
      sourceDiversity: div,
      crossConsensus: consensus,
      now: Date.now(),
    });
    // 位置衰减:排名越靠后,置信度自然衰减(用户更关注前排)
    const positionDecay = Math.max(0, 1 - idx * 0.03);
    const adjustedConfidence = Math.round(conf.confidence * positionDecay * 1000) / 1000;

    return {
      ...r,
      _confidence: {
        ...conf,
        confidence: adjustedConfidence,
        rank: idx + 1,
        sourceDiversity: Math.round(div * 1000) / 1000,
        crossEngineConsensus: Math.round(consensus * 1000) / 1000,
        filterBubbleRisk: bubbleRisk,
      },
    };
  });
}

// ── 5. 核验摘要(供 formatted 输出) ──────────────────────────────────

/**
 * 生成对抗式核验摘要,附加到 formatted 输出末尾。
 * @param {object[]} results  已核验结果(含 _confidence)
 * @returns {string}
 */
function formatVerificationFooter(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  const withConf = results.filter((r) => r && r._confidence);
  if (withConf.length === 0) {
    return '';
  }

  const highConf = withConf.filter((r) => r._confidence.confidence >= 0.7).length;
  const medConf = withConf.filter(
    (r) => r._confidence.confidence >= 0.4 && r._confidence.confidence < 0.7
  ).length;
  const lowConf = withConf.filter((r) => r._confidence.confidence < 0.4).length;

  const promoCount = withConf.filter((r) => r._confidence.flags.includes('paid-promo')).length;
  const spamCount = withConf.filter((r) => r._confidence.flags.includes('seo-spam')).length;
  const singleSource = withConf.filter((r) => r._confidence.flags.includes('single-source')).length;

  // 全局信号
  const firstConf = withConf[0]._confidence;
  const bubbleRisk = firstConf.filterBubbleRisk;
  const diversity = firstConf.sourceDiversity;
  const consensus = firstConf.crossEngineConsensus;

  const parts = [];
  if (highConf > 0) {
    parts.push(`${highConf} 条高置信度`);
  }
  if (medConf > 0) {
    parts.push(`${medConf} 条中等置信度`);
  }
  if (lowConf > 0) {
    parts.push(`${lowConf} 条低置信度(建议核验)`);
  }

  const risks = [];
  if (promoCount > 0) {
    risks.push(`${promoCount} 条疑似推广`);
  }
  if (spamCount > 0) {
    risks.push(`${spamCount} 条疑似 SEO 操纵`);
  }
  if (singleSource > withConf.length * 0.7) {
    risks.push('多数为单一来源');
  }

  const globalSignals = [];
  if (bubbleRisk === 'high') {
    globalSignals.push('⚠️ 信息茧房风险高:结果来源过度集中');
  } else if (bubbleRisk === 'medium') {
    globalSignals.push('信息茧房风险中等:建议拓展搜索词');
  }
  if (diversity < 0.3) {
    globalSignals.push('来源多样性低');
  }
  if (consensus < 0.2) {
    globalSignals.push('跨引擎共识度低');
  }

  let footer = '\n\n🔍 对抗式核验:';
  if (parts.length > 0) {
    footer += `\n  置信度分布 — ${parts.join('、')}`;
  }
  if (risks.length > 0) {
    footer += `\n  风险信号 — ${risks.join('、')}`;
  }
  if (globalSignals.length > 0) {
    footer += `\n  ${globalSignals.join('; ')}`;
  }

  return footer;
}

// ── 工具函数 ─────────────────────────────────────────────────────────

function _extractHost(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

module.exports = {
  sourceDiversity,
  crossEngineConsensus,
  filterBubbleRisk,
  paidPromotionScore,
  seoSpamScore,
  confidenceScore,
  verifyResults,
  formatVerificationFooter,
  // 内部暴露给单测
  __internal: {
    extractHost: _extractHost,
  },
};
