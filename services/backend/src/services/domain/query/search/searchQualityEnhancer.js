'use strict';

/**
 * searchQualityEnhancer.js — 搜索结果质量增强纯叶子(goal 2026-09-05
 * 「提高 khy 有效信息的获取效率,让信息获取更高质量」)。
 *
 * webSearchService 当前的多引擎扇出 + RRF 融合已能聚合跨引擎共识,但缺少
 * 对单条结果本身的质量评估:权威性、摘要相关性、时效性信号、内容密度。
 * 导致「排名靠前 ≠ 内容优质」——聚合引擎排名后,仍有低质、无关、点击诱饵
 * 结果混杂在有效信息里。本叶子补齐这个闭环:
 *
 *   1. 分层域名权威(Tier 1 官方/学术 → Tier 4 未知商业站点)
 *   2. 摘要质量评分(完整性 / 语言匹配 / 关键词密度 / 内容密度)
 *   3. 时效性评分(从 snippet 提取日期信号 + 时间衰减)
 *   4. 综合质量分 = f(RRF分, 权威层级, 摘要质量, 时效性, 跨引擎共识)
 *   5. 智能过滤(链接农场 / 点击诱饵 / 内容过薄)
 *
 * 设计原则(与 searchSourceDiscovery / crossSourceMerge 一脉相承):
 *   - 纯叶子:零 IO、确定性、绝不抛(输入强转)
 *   - 不丢结果:质量分用于重排/标注,过滤仅针对明确低质的信号
 *   - 可配置:阈值、权重一律走 env(KHY_QUALITY_*),夹取到合法区间
 *   - 零硬编码:权威域名表通过 env KHY_QUALITY_TIER1_HOSTS 可扩展
 */

const { tokenizeForSearch } = require('../../../searchTokenizer');

// ── env 工具 ─────────────────────────────────────────────────────────

function _int(envName, fallback, min, max) {
  const raw = parseInt(String(process.env[envName] || ''), 10);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

function _float(envName, fallback, min, max) {
  const raw = parseFloat(String(process.env[envName] || ''));
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

// ── 域名权威分层 ─────────────────────────────────────────────────────
// Tier 1:官方文档 / 学术 / 权威百科 — 最高权威
// Tier 2:主流技术社区 / 知名媒体 — 高权威
// Tier 3:一般博客 / 论坛 — 中等
// Tier 4:未知 / 商业站点 — 最低(不过滤,仅降权)
//
// 内置默认表只是合理起点,用户可通过 env KHY_QUALITY_TIER{1,2,3}_HOSTS
// 追加自定义域名,无需改源码。

function _parseHostList(envName) {
  try {
    const raw = String(process.env[envName] || '').trim();
    if (!raw) {
      return new Set();
    }
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

const _TIER1_HOSTS = new Set([
  'wikipedia.org',
  'developer.mozilla.org',
  'docs.python.org',
  'nodejs.org',
  'arxiv.org',
  'doi.org',
  'ieee.org',
  'acm.org',
  'nature.com',
  'science.org',
  'github.com',
  'gitlab.com',
  'gnu.org',
  'apache.org',
  'nginx.org',
  'kernel.org',
  'w3.org',
  'ecma-international.org',
  '.iso.org',
  'cppreference.com',
  'man7.org',
]);

const _TIER2_HOSTS = new Set([
  'stackoverflow.com',
  'stackexchange.com',
  'reddit.com',
  'medium.com',
  'dev.to',
  'news.ycombinator.com',
  'bbc.com',
  'reuters.com',
  'nytimes.com',
  'theguardian.com',
  'wsj.com',
  'bloomberg.com',
  'github.io',
  'chromium.org',
  'webkit.org',
  'cloudflare.com',
  'aws.amazon.com',
  'learn.microsoft.com',
  'cloud.google.com',
  'docker.com',
  'kubernetes.io',
  'ubuntu.com',
  'debian.org',
  'pytorch.org',
  'tensorflow.org',
  'react.dev',
  'vuejs.org',
  'angular.dev',
  'svelte.dev',
  'rust-lang.org',
  'go.dev',
  'swift.org',
  'kotlinlang.org',
]);

const _TIER3_HOSTS = new Set([
  'zhihu.com',
  'zhuanlan.zhihu.com',
  'csdn.net',
  'blog.csdn.net',
  'juejin.cn',
  'jianshu.com',
  'cnblogs.com',
  'segmentfault.com',
  '51cto.com',
  'infoq.cn',
  'oschina.net',
  'bitbucket.org',
  'notion.so',
  'hashnode.dev',
  'dzone.com',
  'baeldung.com',
  'journal.dev',
]);

const _LINK_FARM_HOSTS = new Set([
  // 链接农场 / 采集站特征域名(可扩展)
  'ask.com',
  'answers.com',
  'wikihow.com',
  'wikia.com',
  'fandom.com',
]);

function _mergeTier(base, extra) {
  const merged = new Set(base);
  for (const h of extra) {
    merged.add(h);
  }
  return merged;
}

/**
 * 解析域名权威层级。返回 1/2/3/4。
 * @param {string} url
 * @returns {1|2|3|4}
 */
function domainTier(url) {
  const host = _extractHostname(url).toLowerCase();
  if (!host) {
    return 4;
  }
  const tier1 = _mergeTier(_TIER1_HOSTS, _parseHostList('KHY_QUALITY_TIER1_HOSTS'));
  const tier2 = _mergeTier(_TIER2_HOSTS, _parseHostList('KHY_QUALITY_TIER2_HOSTS'));
  const tier3 = _mergeTier(_TIER3_HOSTS, _parseHostList('KHY_QUALITY_TIER3_HOSTS'));

  for (const tier of [tier1, tier2, tier3]) {
    for (const known of tier) {
      if (host === known || host.endsWith('.' + known)) {
        return tier === tier1 ? 1 : tier === tier2 ? 2 : 3;
      }
    }
  }
  return 4;
}

function _extractHostname(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── 链接农场检测 ─────────────────────────────────────────────────────

/**
 * 检测 URL / 域名是否匹配链接农场 / 采集站特征。
 * @param {string} url
 * @returns {boolean}
 */
function isLinkFarm(url) {
  const host = _extractHostname(url).toLowerCase();
  if (!host) {
    return false;
  }
  const farms = _mergeTier(_LINK_FARM_HOSTS, _parseHostList('KHY_QUALITY_LINK_FARM_HOSTS'));
  for (const f of farms) {
    if (host === f || host.endsWith('.' + f)) {
      return true;
    }
  }
  return false;
}

// ── 点击诱饵模式检测 ─────────────────────────────────────────────────

const _CLICKBAIT_PATTERNS = [
  /你绝对想不到/i,
  /震惊/i,
  /惊呆/i,
  /99%的人不知道/i,
  /不看后悔/i,
  /速看.*删/i,
  /刚刚.*曝光/i,
  /重磅.*突发/i,
  /独家.*揭秘/i,
  /must see/i,
  /you won'?t believe/i,
  /shocking/i,
  /mind-blowing/i,
  /jaw-dropping/i,
  /this one trick/i,
  /doctors hate/i,
  /secret they don'?t want/i,
];

const _CLIPBAIT_TITLE_LENGTH_TOO_SHORT = 8; // 过短标题(字符)疑似标题党

/**
 * 检测标题是否含点击诱饵特征。返回 0(无) ~ 1(高度疑似)。
 * @param {string} title
 * @returns {number}
 */
function clickbaitScore(title) {
  const t = String(title || '').trim();
  if (!t) {
    return 0;
  }
  let score = 0;
  for (const p of _CLICKBAIT_PATTERNS) {
    if (p.test(t)) {
      score += 0.4;
      break; // 只计一次
    }
  }
  // 过短标题倾向标题党
  if (t.length < _CLIPBAIT_TITLE_LENGTH_TOO_SHORT) {
    score += 0.2;
  }
  // 感叹号密度
  const exclaimCount = (t.match(/[！!]/g) || []).length;
  if (exclaimCount >= 3) {
    score += 0.2;
  } else if (exclaimCount >= 2) {
    score += 0.1;
  }
  // 全角问号/叹号堆砌
  const punctuationDensity = (t.match(/[？！!?。.。]/g) || []).length / Math.max(t.length, 1);
  if (punctuationDensity > 0.3) {
    score += 0.15;
  }
  return Math.min(score, 1);
}

// ── 摘要质量评分 ─────────────────────────────────────────────────────

/**
 * 评估单条摘要的信息密度 / 完整性。
 * 返回 0(空白) ~ 1(高质量完整摘要)。
 *
 * 维度:
 *   - 长度适中(非过短 / 非灌水)
 *   - 含完整句子(句号 / 逗号分布)
 *   - 非纯导航/标签文本
 *   - 与查询关键词的关联度(可选,需传 query)
 *
 * @param {string} snippet
 * @param {string} [query]  可选,传入时评估关键词关联度
 * @returns {number}
 */
function snippetQuality(snippet, query) {
  const s = String(snippet || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) {
    return 0;
  }
  let score = 0;

  // 长度信号:40-200 字符是「完整摘要」甜区
  const len = s.length;
  if (len >= 40 && len <= 200) {
    score += 0.3;
  } else if (len >= 20 && len < 40) {
    score += 0.15;
  } else if (len > 200 && len <= 400) {
    score += 0.2; // 较长但仍有信息
  } else if (len > 400) {
    score += 0.1; // 过长,可能是整段正文
  }

  // 句子结构:含逗号 / 句号暗示完整句子
  const sentenceMarks = (s.match(/[，。、；,;]/g) || []).length;
  if (sentenceMarks >= 2) {
    score += 0.2;
  } else if (sentenceMarks === 1) {
    score += 0.1;
  }

  // 导航/标签噪声特征:纯空格分隔短词组、过多样式符
  const noiseChars = (s.match(/[|\-—·•●■□▪▬►▶▸▹]/g) || []).length;
  if (noiseChars >= 3) {
    score -= 0.15; // 疑似导航栏文本
  }

  // 数字/日期/版本号密度(信息密度信号)
  const infoDigits = (s.match(/\d{2,4}/g) || []).length;
  if (infoDigits >= 1 && infoDigits <= 5) {
    score += 0.1;
  }

  // 关键词关联度(可选)
  if (query && query.trim()) {
    try {
      const queryTerms = tokenizeForSearch(query);
      if (queryTerms.length > 0) {
        const snippetTerms = new Set(tokenizeForSearch(s));
        let hitCount = 0;
        for (const qt of queryTerms) {
          if (snippetTerms.has(qt)) {
            hitCount += 1;
          }
        }
        const hitRatio = hitCount / queryTerms.length;
        score += hitRatio * 0.3; // 最多加 0.3
      }
    } catch {
      /* ignore */
    }
  }

  return Math.max(0, Math.min(1, score));
}

// ── 时效性评分 ───────────────────────────────────────────────────────

const _DATE_PATTERNS = [
  /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/, // 2024-01-15 或 2024/1/15
  /(\d{4})年(\d{1,2})月(\d{1,2})日?/, // 2024年1月15日
  /(\d{1,2})月前/,
  /(\d{1,2})周前/,
  /(\d{1,2})天前/,
  /(\d{1,2})小时前/,
  /(\d{1,2})分钟前/,
  /(\d{1,2})\s*months?\s*ago/i,
  /(\d{1,2})\s*weeks?\s*ago/i,
  /(\d{1,2})\s*days?\s*ago/i,
  /(\d{1,2})\s*hours?\s*ago/i,
  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i,
  /\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{4}/i,
];

/**
 * 从 snippet / publishedDate 提取时间戳。无法解析返回 null。
 * @param {string} snippet
 * @param {string} [publishedDate]
 * @param {number} now  Date.now()
 * @returns {number|null} epoch ms
 */
function extractTimestamp(snippet, publishedDate, now) {
  // 优先使用已有 publishedDate
  if (publishedDate) {
    const t = Date.parse(publishedDate);
    if (Number.isFinite(t)) {
      return t;
    }
  }
  const text = String(snippet || '');
  if (!text) {
    return null;
  }

  // 绝对日期匹配
  for (const p of _DATE_PATTERNS) {
    const m = text.match(p);
    if (m) {
      // 跳过相对时间(月/周/天/时/分前),信号较弱
      if (/月前|周前|天前|小时前|分钟前|ago/i.test(m[0])) {
        continue;
      }
      const t = Date.parse(m[0]);
      if (Number.isFinite(t) && t <= now && t < now + 86400000) {
        // 不超现在+1天
        return t;
      }
    }
  }
  return null;
}

/**
 * 时效性评分:越近越高。返回 0(无时间信号或很旧) ~ 1(今天)。
 * @param {number|null} ts  epoch ms
 * @param {number} now       Date.now()
 * @returns {number}
 */
function recencyScore(ts, now) {
  if (!ts || !Number.isFinite(ts)) {
    return 0.3; // 无时间信号 → 中性分,不奖不惩
  }
  const ageDays = (now - ts) / 86400000;
  if (ageDays < 0) {
    return 0.3; // 未来日期 → 可能是解析错误
  }
  if (ageDays <= 1) {
    return 1;
  }
  if (ageDays <= 7) {
    return 0.9;
  }
  if (ageDays <= 30) {
    return 0.75;
  }
  if (ageDays <= 90) {
    return 0.6;
  }
  if (ageDays <= 365) {
    return 0.45;
  }
  // 指数衰减:1年→0.45, 3年→0.2, 10年→0.05
  return Math.max(0.05, 0.45 * Math.exp(-0.4 * (ageDays / 365 - 1)));
}

// ── 内容密度 / 过薄检测 ──────────────────────────────────────────────

/**
 * 检测 snippet 是否为「过薄」内容(无实质信息)。
 * 过薄信号:极短、纯标签、无完整句子、无信息数字。
 * @param {string} snippet
 * @returns {boolean}
 */
function isThinContent(snippet) {
  const s = String(snippet || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length < 15) {
    return true; // 过短
  }
  // 无逗号句号且长度 < 30 → 疑似标签串
  if (s.length < 30 && !/[，。、,;]/.test(s)) {
    return true;
  }
  return false;
}

// ── 综合质量评分 ─────────────────────────────────────────────────────

/**
 * 对单条搜索结果计算综合质量分。纯函数,无 IO。
 *
 * 综合分 = wAuthority * authorityScore
 *        + wSnippet * snippetScore
 *        + wRecency * recencyScore
 *        + wConsensus * consensusScore
 *        - clickbaitPenalty
 *        - linkFarmPenalty
 *
 * 各维度归一化到 [0,1],权重由 env 配置(默认和为 1)。
 *
 * @param {object} result   { title, url, snippet, engineCount?, publishedDate? }
 * @param {object} opts
 * @param {string} opts.query  原始查询(用于关键词关联度)
 * @param {number} opts.now    Date.now()
 * @returns {{ total:number, authority:number, snippet:number, recency:number, consensus:number, clickbait:number, flags:string[] }}
 */
function qualityScore(result, opts = {}) {
  const { query = '', now = Date.now() } = opts;
  const r = result || {};
  const flags = [];

  // 权威分:Tier1→1.0, Tier2→0.8, Tier3→0.6, Tier4→0.3
  const tier = domainTier(r.url || '');
  const authorityScore = tier === 1 ? 1 : tier === 2 ? 0.8 : tier === 3 ? 0.6 : 0.3;
  if (tier === 1) {
    flags.push('tier1');
  }

  // 摘要质量
  const snippetScore = snippetQuality(r.snippet, query);
  if (snippetScore >= 0.6) {
    flags.push('rich-snippet');
  }

  // 时效性
  const ts = extractTimestamp(r.snippet, r.publishedDate, now);
  const recency = recencyScore(ts, now);
  if (recency >= 0.9) {
    flags.push('fresh');
  }

  // 跨引擎共识:被 ≥3 引擎收录 → 1.0, 2 → 0.7, 1 → 0.3
  const ec = Number.isFinite(r.engineCount) ? r.engineCount : 1;
  const consensusScore = ec >= 3 ? 1 : ec === 2 ? 0.7 : 0.3;
  if (ec >= 2) {
    flags.push('consensus');
  }

  // 点击诱饵惩罚
  const cbScore = clickbaitScore(r.title);
  if (cbScore >= 0.4) {
    flags.push('clickbait');
  }

  // 链接农场惩罚
  const isFarm = isLinkFarm(r.url || '');
  if (isFarm) {
    flags.push('linkfarm');
  }

  // 过薄内容惩罚
  const thin = isThinContent(r.snippet);
  if (thin) {
    flags.push('thin');
  }

  // 权重(可配置)
  const wAuthority = _float('KHY_QUALITY_W_AUTHORITY', 0.25, 0, 1);
  const wSnippet = _float('KHY_QUALITY_W_SNIPPET', 0.3, 0, 1);
  const wRecency = _float('KHY_QUALITY_W_RECENCY', 0.2, 0, 1);
  const wConsensus = _float('KHY_QUALITY_W_CONSENSUS', 0.25, 0, 1);

  const raw =
    wAuthority * authorityScore +
    wSnippet * snippetScore +
    wRecency * recency +
    wConsensus * consensusScore;

  // 惩罚项
  const clickbaitPenalty = cbScore * _float('KHY_QUALITY_PENALTY_CLICKBAIT', 0.5, 0, 1);
  const linkFarmPenalty = isFarm ? _float('KHY_QUALITY_PENALTY_LINKFARM', 0.6, 0, 1) : 0;
  const thinPenalty = thin ? _float('KHY_QUALITY_PENALTY_THIN', 0.3, 0, 1) : 0;

  const total = Math.max(0, Math.min(1, raw - clickbaitPenalty - linkFarmPenalty - thinPenalty));

  return {
    total: Math.round(total * 1000) / 1000,
    authority: Math.round(authorityScore * 1000) / 1000,
    snippet: Math.round(snippetScore * 1000) / 1000,
    recency: Math.round(recency * 1000) / 1000,
    consensus: Math.round(consensusScore * 1000) / 1000,
    clickbait: Math.round(cbScore * 1000) / 1000,
    flags,
  };
}

// ── 批量重排 ─────────────────────────────────────────────────────────

/**
 * 对融合后的结果列表做质量感知重排。
 *
 * 策略:RRF 分(跨引擎共识)为主干,质量分为调节因子。
 * 不丢结果,仅调整顺序 + 附加质量标注。
 *
 * 重排公式:
 *   finalScore = rrfScore * (1 + qualityBoost)
 * 其中 qualityBoost = (qualityTotal - 0.5) * boostFactor
 *   → 高质量结果上浮,低质量结果下沉,但不改变 RRF 主导排序
 *
 * @param {object[]} results  已 RRF 融合的结果(含 _rrfScore 或 engineCount)
 * @param {object} opts
 * @param {string} opts.query
 * @param {number} [opts.now]
 * @param {number} [opts.boostFactor]  质量调节强度,默认 env / 0.5
 * @returns {object[]} 重排后结果(附加 _quality 字段)
 */
function rerankWithQuality(results, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) {
    return results || [];
  }
  const { query = '', now = Date.now() } = opts;
  const boostFactor = Number.isFinite(opts.boostFactor)
    ? opts.boostFactor
    : _float('KHY_QUALITY_BOOST_FACTOR', 0.5, 0, 2);

  // 预计算 RRF 分(若上游未注入,从 engineCount 估算)
  const scored = results.map((r) => {
    const rrfScore =
      Number.isFinite(r._rrfScore) && r._rrfScore > 0
        ? r._rrfScore
        : Number.isFinite(r.engineCount) && r.engineCount > 0
          ? r.engineCount * 0.1
          : 0.05;
    const q = qualityScore(r, { query, now });
    const qualityBoost = (q.total - 0.5) * boostFactor;
    const finalScore = rrfScore * (1 + qualityBoost);
    return {
      ...r,
      _rrfScore: rrfScore,
      _quality: q,
      _finalScore: Math.round(finalScore * 10000) / 10000,
    };
  });

  // 按 finalScore 降序,同分按 RRF 分,再同分按 engineCount
  scored.sort((a, b) => {
    if (b._finalScore !== a._finalScore) {
      return b._finalScore - a._finalScore;
    }
    if (b._rrfScore !== a._rrfScore) {
      return b._rrfScore - a._rrfScore;
    }
    return (b.engineCount || 0) - (a.engineCount || 0);
  });

  return scored;
}

// ── 质量摘要(供 formatted 输出) ──────────────────────────────────────

/**
 * 生成质量摘要标注,附加到 formatted 输出末尾。
 * @param {object[]} results  已重排结果(含 _quality)
 * @returns {string}
 */
function formatQualityFooter(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  const withQuality = results.filter((r) => r && r._quality);
  if (withQuality.length === 0) {
    return '';
  }

  const tier1Count = withQuality.filter((r) => r._quality.flags.includes('tier1')).length;
  const consensusCount = withQuality.filter((r) => r._quality.flags.includes('consensus')).length;
  const freshCount = withQuality.filter((r) => r._quality.flags.includes('fresh')).length;
  const thinCount = withQuality.filter((r) => r._quality.flags.includes('thin')).length;
  const clickbaitCount = withQuality.filter((r) => r._quality.flags.includes('clickbait')).length;

  const parts = [];
  if (tier1Count > 0) {
    parts.push(`${tier1Count} 条权威来源`);
  }
  if (consensusCount > 0) {
    parts.push(`${consensusCount} 条跨引擎共识`);
  }
  if (freshCount > 0) {
    parts.push(`${freshCount} 条近期内容`);
  }
  if (thinCount > 0) {
    parts.push(`${thinCount} 条内容过薄(已降权)`);
  }
  if (clickbaitCount > 0) {
    parts.push(`${clickbaitCount} 条疑似标题党(已降权)`);
  }

  if (parts.length === 0) {
    return '';
  }
  return `\n\n📊 质量概览: ${parts.join('、')}。`;
}

module.exports = {
  domainTier,
  isLinkFarm,
  clickbaitScore,
  snippetQuality,
  extractTimestamp,
  recencyScore,
  isThinContent,
  qualityScore,
  rerankWithQuality,
  formatQualityFooter,
  // 内部暴露给单测
  __internal: {
    extractHostname: _extractHostname,
    mergeTier: _mergeTier,
    parseHostList: _parseHostList,
  },
};
