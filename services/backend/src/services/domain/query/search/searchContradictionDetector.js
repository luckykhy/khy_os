'use strict';

/**
 * searchContradictionDetector.js — 搜索结果矛盾检测纯叶子(goal 2026-09-05
 * 「对抗式核验:矛盾检测」)。
 *
 * 上一阶段的 searchSourceChainResolver 解决了「溯源级」分析问题,但搜索系统
 * 仍缺少「矛盾级」核验:不同来源对同一主题的描述是否存在矛盾?哪些声明互相冲突?
 * 本叶子从结果中识别矛盾信号:
 *
 *   1. 数值矛盾检测(Numerical Contradiction Detection)
 *      - 同一指标不同数值(「GDP 增长 5.2%」vs「GDP 增长 4.8%」)
 *      - 同一事件不同日期
 *      - 同一实体不同属性值
 *
 *   2. 极性矛盾检测(Polarity Contradiction Detection)
 *      - 同一主题的正反观点(「X 有效」vs「X 无效」)
 *      - 褒贬极性冲突
 *      - 因果方向矛盾(「X 导致 Y」vs「Y 导致 X」)
 *
 *   3. 矛盾严重度评分(Contradiction Severity Score)
 *      - 综合「矛盾类型 + 涉及来源数 + 来源权威性」
 *      - 输出矛盾列表 + 严重度 + 建议核验方向
 *
 * 设计原则(与 searchQualityEnhancer / searchAdversarialVerifier / searchClaimVerifier / searchSourceChainResolver 一脉相承):
 *   - 纯叶子:零 IO、确定性、绝不抛(输入强转)
 *   - 不丢结果:矛盾信号用于标注,不删除结果
 *   - 可配置:阈值一律走 env(KHY_CONTRADICTION_*)
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
  return Math.min(max, Math.max(min, max));
}

// ── 1. 数值矛盾检测 ─────────────────────────────────────────────────

/**
 * 从 snippet 中提取可比较的数值指标。
 * 返回 [{ metric, value, unit, context }]
 *
 * @param {string} snippet
 * @returns {Array<{metric:string, value:number, unit:string, context:string}>}
 */
function extractMetrics(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return [];
  }
  const metrics = [];

  // 百分比指标
  const pctPattern = /(.{2,30}?)(?:达到|为|是|约|高达|低至|超过|不足|近)\s*(\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = pctPattern.exec(text)) !== null) {
    metrics.push({
      metric: m[1].trim(),
      value: parseFloat(m[2]),
      unit: '%',
      context: _context(text, m.index, m[0].length),
    });
  }

  // 数量指标
  const qtyPattern = /(.{2,30}?)(?:达到|为|是|约|高达|低至|超过|不足|近)\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(万|亿|百万|千|亿|bytes?|kb|mb|gb|tb|ms|s|分钟|小时|天|年|人|次|个)/g;
  while ((m = qtyPattern.exec(text)) !== null) {
    metrics.push({
      metric: m[1].trim(),
      value: parseFloat(m[2].replace(/,/g, '')),
      unit: m[3],
      context: _context(text, m.index, m[0].length),
    });
  }

  // 排名指标
  const rankPattern = /(.{2,30}?)(?:排名|位居|位列)(?:第)?\s*(\d+)(?:位|名)/g;
  while ((m = rankPattern.exec(text)) !== null) {
    metrics.push({
      metric: m[1].trim(),
      value: parseInt(m[2], 10),
      unit: 'rank',
      context: _context(text, m.index, m[0].length),
    });
  }

  return metrics;
}

/**
 * 检测数值矛盾:同一指标不同数值。
 * 返回 [{ metric, values:[{value, unit, source}], severity }]
 *
 * @param {object[]} results  含 snippet, domain, url 的结果
 * @returns {Array<{metric:string, values:Array<{value:number, unit:string, source:string}>, severity:number}>}
 */
function detectNumericalContradictions(results) {
  if (!Array.isArray(results) || results.length < 2) {
    return [];
  }

  // 收集所有指标
  const metricIndex = new Map(); // metric -> [{ value, unit, source }]
  for (const r of results) {
    const metrics = extractMetrics(r.snippet || '');
    const source = r.domain || r.url || '';
    for (const m of metrics) {
      const key = `${m.metric}::${m.unit}`;
      if (!metricIndex.has(key)) {
        metricIndex.set(key, []);
      }
      metricIndex.get(key).push({ value: m.value, unit: m.unit, source });
    }
  }

  const contradictions = [];
  for (const [key, entries] of metricIndex.entries()) {
    if (entries.length < 2) {
      continue;
    }
    // 检查数值是否一致
    const uniqueValues = new Set(entries.map((e) => e.value));
    if (uniqueValues.size > 1) {
      // 计算严重度:数值差异越大,严重度越高
      const values = [...uniqueValues];
      const maxVal = Math.max(...values);
      const minVal = Math.min(...values);
      const avgVal = values.reduce((a, b) => a + b, 0) / values.length;
      const spread = avgVal !== 0 ? (maxVal - minVal) / Math.abs(avgVal) : 0;
      const severity = Math.min(spread, 1); // 归一化到 0~1

      contradictions.push({
        metric: key.split('::')[0],
        values: entries,
        severity: Math.round(severity * 1000) / 1000,
        spread,
      });
    }
  }

  return contradictions.sort((a, b) => b.severity - a.severity);
}

// ── 2. 极性矛盾检测 ─────────────────────────────────────────────────

// 正面极性词汇
const _POSITIVE_WORDS = [
  '有效', '成功', '提升', '增长', '改善', '优化', '突破', '创新', '领先', '优势',
  '推荐', '支持', '赞同', '肯定', '认可', '满意', '好评', '热门', '流行', '首选',
  'efficient', 'effective', 'successful', 'improved', 'growth', 'innovation', 'leading',
  'recommended', 'supported', 'approved', 'satisfied', 'popular', 'best', 'top',
];

// 负面极性词汇
const _NEGATIVE_WORDS = [
  '无效', '失败', '下降', '恶化', '退化', '落后', '劣势', '反对', '批评', '质疑',
  '警告', '风险', '问题', '缺陷', '漏洞', '崩溃', '故障', '事故', '丑闻', '争议',
  'ineffective', 'failed', 'declined', 'worsened', 'regressed', 'backward', 'disadvantage',
  'opposed', 'criticized', 'questioned', 'warned', 'risk', 'problem', 'defect', 'vulnerability',
  'crash', 'failure', 'accident', 'scandal', 'controversy',
];

// 极性反转信号
const _POLARITY_REVERSAL = [
  /虽然.*但是/,
  /尽管.*还是/,
  /然而/,
  /但是/,
  /不过/,
  /可是/,
  /却/,
  /while.*however/i,
  /although.*but/i,
  /despite.*still/i,
  /nevertheless/i,
  /nonetheless/i,
  /however/i,
  /but/i,
  /yet/i,
];

/**
 * 计算 snippet 的情感极性分数。
 * 返回 -1(完全负面) ~ 1(完全正面)。
 *
 * @param {string} snippet
 * @returns {number}
 */
function polarityScore(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return 0;
  }
  let score = 0;
  for (const w of _POSITIVE_WORDS) {
    if (text.includes(w)) {
      score += 0.15;
    }
  }
  for (const w of _NEGATIVE_WORDS) {
    if (text.includes(w)) {
      score -= 0.15;
    }
  }
  // 极性反转信号:反转后极性权重降低(更中性)
  for (const p of _POLARITY_REVERSAL) {
    if (p.test(text)) {
      score *= 0.5; // 反转后更中性
      break;
    }
  }
  return Math.max(-1, Math.min(1, score));
}

/**
 * 检测极性矛盾:同一主题的正反观点。
 * 返回 [{ topic, positive:[], negative:[], severity }]
 *
 * @param {object[]} results  含 snippet, domain, url 的结果
 * @param {string} query  原始查询(用于提取主题)
 * @returns {Array<{topic:string, positive:object[], negative:object[], severity:number}>}
 */
function detectPolarityContradictions(results, query) {
  if (!Array.isArray(results) || results.length < 2) {
    return [];
  }

  // 提取查询主题(关键词)
  const queryTerms = tokenizeForSearch(query || '');
  if (queryTerms.length === 0) {
    return [];
  }

  // 计算每条结果的极性
  const polarities = results.map((r) => ({
    result: r,
    polarity: polarityScore(r.snippet || ''),
    source: r.domain || r.url || '',
  }));

  // 分组:正面 vs 负面
  const positive = polarities.filter((p) => p.polarity > 0.2);
  const negative = polarities.filter((p) => p.polarity < -0.2);

  const contradictions = [];
  if (positive.length > 0 && negative.length > 0) {
    // 存在极性矛盾
    const posAvg = positive.reduce((a, b) => a + b.polarity, 0) / positive.length;
    const negAvg = negative.reduce((a, b) => a + b.polarity, 0) / negative.length;
    const severity = Math.min(Math.abs(posAvg - negAvg) / 2, 1);

    contradictions.push({
      topic: queryTerms.slice(0, 3).join(' '),
      positive: positive.slice(0, 3).map((p) => ({
        source: p.source,
        polarity: Math.round(p.polarity * 1000) / 1000,
      })),
      negative: negative.slice(0, 3).map((p) => ({
        source: p.source,
        polarity: Math.round(p.polarity * 1000) / 1000,
      })),
      severity: Math.round(severity * 1000) / 1000,
    });
  }

  return contradictions;
}

// ── 3. 因果方向矛盾检测 ──────────────────────────────────────────────

/**
 * 检测因果方向矛盾:「X 导致 Y」vs「Y 导致 X」。
 * 返回 [{ subject, object, forward:[], reverse:[], severity }]
 *
 * @param {object[]} results  含 snippet 的结果
 * @returns {Array<{subject:string, object:string, forward:object[], reverse:object[], severity:number}>}
 */
function detectCausalContradictions(results) {
  if (!Array.isArray(results) || results.length < 2) {
    return [];
  }

  // 提取因果对
  const causalPairs = [];
  for (const r of results) {
    const text = String(r.snippet || '');
    const source = r.domain || r.url || '';

    // 「X 导致 Y」
    const causePattern = /(.{2,20}?)(?:导致|使得|引起|造成|带来)(.{2,30}?)(?:[。，,；;]|$)/g;
    let m;
    while ((m = causePattern.exec(text)) !== null) {
      causalPairs.push({
        subject: m[1].trim(),
        object: m[2].trim(),
        direction: 'forward',
        source,
      });
    }

    // 「X 是因为 Y」「X 由于 Y」
    const becausePattern = /(.{2,20}?)(?:是因为|由于|源于|来自)(.{2,30}?)(?:[。，,；;]|$)/g;
    while ((m = becausePattern.exec(text)) !== null) {
      causalPairs.push({
        subject: m[2].trim(), // 原因
        object: m[1].trim(), // 结果
        direction: 'reverse',
        source,
      });
    }
  }

  // 检测方向矛盾
  const pairIndex = new Map();
  for (const cp of causalPairs) {
    const key = `${cp.subject}::${cp.object}`;
    const reverseKey = `${cp.object}::${cp.subject}`;
    if (pairIndex.has(reverseKey)) {
      // 发现反向因果
      const existing = pairIndex.get(reverseKey);
      pairIndex.set(reverseKey, {
        ...existing,
        reverse: [...existing.reverse, { source: cp.source }],
      });
      pairIndex.set(key, {
        subject: cp.subject,
        object: cp.object,
        forward: [...(pairIndex.get(key)?.forward || []), { source: cp.source }],
        reverse: existing.reverse,
      });
    } else {
      if (!pairIndex.has(key)) {
        pairIndex.set(key, { subject: cp.subject, object: cp.object, forward: [], reverse: [] });
      }
      const existing = pairIndex.get(key);
      if (cp.direction === 'forward') {
        existing.forward.push({ source: cp.source });
      } else {
        existing.reverse.push({ source: cp.source });
      }
    }
  }

  const contradictions = [];
  for (const [key, entry] of pairIndex.entries()) {
    if (entry.forward.length > 0 && entry.reverse.length > 0) {
      contradictions.push({
        subject: entry.subject,
        object: entry.object,
        forward: entry.forward,
        reverse: entry.reverse,
        severity: Math.min((entry.forward.length + entry.reverse.length) * 0.2, 1),
      });
    }
  }

  return contradictions;
}

// ── 4. 矛盾严重度评分 ────────────────────────────────────────────────

/**
 * 对结果集合做综合矛盾检测。
 *
 * @param {object[]} results  含 snippet, domain, url 的结果
 * @param {string} query  原始查询
 * @returns {{ numerical:object[], polarity:object[], causal:object[], overallSeverity:number, flags:string[] }}
 */
function detectAllContradictions(results, query) {
  if (!Array.isArray(results) || results.length < 2) {
    return { numerical: [], polarity: [], causal: [], overallSeverity: 0, flags: [] };
  }

  const numerical = detectNumericalContradictions(results);
  const polarity = detectPolarityContradictions(results, query);
  const causal = detectCausalContradictions(results);

  // 综合严重度
  const numSeverity = numerical.length > 0 ? numerical[0].severity : 0;
  const polSeverity = polarity.length > 0 ? polarity[0].severity : 0;
  const cauSeverity = causal.length > 0 ? causal[0].severity : 0;
  const overallSeverity = Math.max(numSeverity, polSeverity, cauSeverity);

  const flags = [];
  if (numerical.length > 0) {
    flags.push('numerical-contradiction');
  }
  if (polarity.length > 0) {
    flags.push('polarity-contradiction');
  }
  if (causal.length > 0) {
    flags.push('causal-contradiction');
  }

  return { numerical, polarity, causal, overallSeverity, flags };
}

// ── 5. 批量矛盾检测 ─────────────────────────────────────────────────

/**
 * 对结果列表做矛盾检测,附加矛盾标注。
 *
 * @param {object[]} results  已溯源分析的结果
 * @param {string} query  原始查询
 * @returns {object[]} 检测结果(附加 _contradictions)
 */
function detectContradictions(results, query) {
  if (!Array.isArray(results) || results.length === 0) {
    return results || [];
  }

  const detection = detectAllContradictions(results, query);

  return results.map((r) => ({
    ...r,
    _contradictions: detection,
  }));
}

// ── 6. 矛盾摘要(供 formatted 输出) ──────────────────────────────────

/**
 * 生成矛盾检测摘要,附加到 formatted 输出末尾。
 * @param {object[]} results  已矛盾检测结果(含 _contradictions)
 * @returns {string}
 */
function formatContradictionFooter(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  const first = results[0];
  if (!first || !first._contradictions) {
    return '';
  }
  const c = first._contradictions;
  if (c.flags.length === 0) {
    return '';
  }

  let footer = '\n\n⚡ 矛盾检测:';
  const parts = [];
  if (c.numerical.length > 0) {
    parts.push(`${c.numerical.length} 处数值矛盾`);
  }
  if (c.polarity.length > 0) {
    parts.push(`${c.polarity.length} 处观点对立`);
  }
  if (c.causal.length > 0) {
    parts.push(`${c.causal.length} 处因果方向矛盾`);
  }
  footer += '\n  ' + parts.join('、');

  // 展示 top 数值矛盾
  if (c.numerical.length > 0) {
    footer += '\n  数值矛盾:';
    for (const nc of c.numerical.slice(0, 2)) {
      const vals = nc.values.map((v) => `${v.value}${v.unit}`).join(' vs ');
      footer += `\n    • ${nc.metric}: ${vals}`;
    }
  }

  // 展示 top 极性矛盾
  if (c.polarity.length > 0) {
    footer += '\n  观点对立:';
    for (const pc of c.polarity.slice(0, 2)) {
      footer += `\n    • ${pc.topic}: 正(${pc.positive.length}) 反(${pc.negative.length})`;
    }
  }

  // 综合严重度
  if (c.overallSeverity >= 0.7) {
    footer += '\n  ⚠️ 高度矛盾:建议深入核查原始来源';
  } else if (c.overallSeverity >= 0.4) {
    footer += '\n  ⚡ 中度矛盾:注意甄别不同来源立场';
  }

  return footer;
}

// ── 工具函数 ─────────────────────────────────────────────────────────

function _context(text, start, length) {
  const ctxStart = Math.max(0, start - 20);
  const ctxEnd = Math.min(text.length, start + length + 20);
  return text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
}

module.exports = {
  extractMetrics,
  detectNumericalContradictions,
  polarityScore,
  detectPolarityContradictions,
  detectCausalContradictions,
  detectAllContradictions,
  detectContradictions,
  formatContradictionFooter,
  // 内部暴露给单测
  __internal: {
    context: _context,
  },
};
