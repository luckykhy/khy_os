'use strict';

/**
 * searchSourceChainResolver.js — 搜索结果溯源链解析纯叶子(goal 2026-09-05
 * 「对抗式核验:溯源链分析」)。
 *
 * 上一阶段的 searchClaimVerifier 解决了「声明级」核验问题,但搜索系统仍缺少
 * 「溯源级」分析:一条信息最初来自哪里?是原始来源还是二手转引?引用链是否完整?
 * 本叶子从结果中识别溯源信号:
 *
 *   1. 原始来源识别(Primary Source Detection)
 *      - 区分「原始研究/官方发布」vs「媒体报道」vs「二手转载」
 *      - 识别来源层级:一手 > 二手 > 三手
 *
 *   2. 引用链分析(Citation Chain Analysis)
 *      - 检测 snippet 中的引用信号(「根据…」「援引…」「据报道…」)
 *      - 识别原始出处实体(机构/论文/报告/官方)
 *      - 评估引用链完整性
 *
 *   3. 溯源可信度(Provenance Score)
 *      - 综合「来源层级 + 引用链完整性 + 原始来源权威性」
 *      - 输出溯源等级 + 建议追溯方向
 *
 * 设计原则(与 searchQualityEnhancer / searchAdversarialVerifier / searchClaimVerifier 一脉相承):
 *   - 纯叶子:零 IO、确定性、绝不抛(输入强转)
 *   - 不丢结果:溯源信号用于标注,不删除结果
 *   - 可配置:阈值一律走 env(KHY_PROVENANCE_*)
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

// ── 1. 来源层级识别 ─────────────────────────────────────────────────

// 原始来源特征域名/路径(一手来源)
const _PRIMARY_SOURCE_HOSTS = new Set([
  'arxiv.org',
  'doi.org',
  'ieee.org',
  'acm.org',
  'nature.com',
  'science.org',
  'cell.com',
  'thelancet.com',
  'nejm.org',
  'pnas.org',
  'springer.com',
  'link.springer.com',
  'sciencedirect.com',
  'wiley.com',
  'tandfonline.com',
  'sagepub.com',
  'oup.com',
  'cambridge.org',
  'nih.gov',
  'ncbi.nlm.nih.gov',
  'who.int',
  'un.org',
  'worldbank.org',
  'imf.org',
  'oecd.org',
  'gov.cn',
  'stats.gov.cn',
  'pbc.gov.cn',
  'csrc.gov.cn',
  'sec.gov',
  'federalreserve.gov',
  'ecb.europa.eu',
  'company.com', // placeholder
]);

// 原始来源 URL 路径特征
const _PRIMARY_SOURCE_PATHS = [
  /\/abs\/\d+\.\d+/,
  /\/doi\//,
  /\/article\//,
  /\/paper\//,
  /\/publication\//,
  /\/pub\//,
  /\/release\//,
  /\/press[-_]?release\//,
  /\/statement\//,
  /\/report\//,
  /\/whitepaper\//,
  /\/data\//,
  /\/dataset\//,
];

// 二手转引特征词汇
const _SECONDARY_SIGNALS = [
  /根据/,
  /援引/,
  /据报道/,
  /据.*报道/,
  /援引.*消息/,
  /转引/,
  /转载/,
  /引用/,
  /according to/i,
  /reported by/i,
  /cited in/i,
  /as reported/i,
  /as cited/i,
  /sources say/i,
  /sources said/i,
];

/**
 * 判断来源层级。
 * 返回 'primary' | 'secondary' | 'tertiary' | 'unknown'
 *
 * @param {string} url
 * @param {string} snippet
 * @returns {'primary'|'secondary'|'tertiary'|'unknown'}
 */
function sourceLevel(url, snippet) {
  const host = _extractHost(url).toLowerCase();
  if (!host) {
    return 'unknown';
  }

  // 检查域名是否在原始来源集合
  for (const primary of _PRIMARY_SOURCE_HOSTS) {
    if (host === primary || host.endsWith('.' + primary)) {
      return 'primary';
    }
  }

  // 检查 URL 路径是否匹配原始来源特征
  const path = _extractPath(url).toLowerCase();
  for (const p of _PRIMARY_SOURCE_PATHS) {
    if (p.test(path)) {
      return 'primary';
    }
  }

  // 检查 snippet 中是否有二手转引信号
  const s = String(snippet || '');
  for (const signal of _SECONDARY_SIGNALS) {
    if (signal.test(s)) {
      return 'secondary';
    }
  }

  // 检查是否是新闻/媒体(三手)
  if (_isMediaDomain(host)) {
    return 'tertiary';
  }

  return 'unknown';
}

function _isMediaDomain(host) {
  const mediaPatterns = [
    'bbc.com', 'bbc.co.uk',
    'reuters.com',
    'nytimes.com',
    'theguardian.com',
    'wsj.com',
    'bloomberg.com',
    'apnews.com',
    'cnn.com',
    'foxnews.com',
    'nbcnews.com',
    'abcnews.go.com',
    'pbs.org',
    'npr.org',
    'xinhuanet.com',
    'people.com.cn',
    'chinadaily.com.cn',
    'globaltimes.cn',
    'caixin.com',
    'thepaper.cn',
    '36kr.com',
    'huxiu.com',
    'jiqizhixin.com',
    'ithome.com',
    '36kr.com',
  ];
  for (const m of mediaPatterns) {
    if (host === m || host.endsWith('.' + m)) {
      return true;
    }
  }
  return false;
}

// ── 2. 引用链分析 ───────────────────────────────────────────────────

/**
 * 从 snippet 中提取引用链信号。
 * 返回 [{ signal, entity, type }]
 *
 * @param {string} snippet
 * @returns {Array<{signal:string, entity:string, type:string}>}
 */
function extractCitationSignals(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return [];
  }
  const signals = [];

  // 「根据 X」
  const accordingTo = /根据(.{2,40}?)(?:的)?(?:报告|研究|数据|统计|发布|消息|声明)/g;
  let m;
  while ((m = accordingTo.exec(text)) !== null) {
    signals.push({ signal: 'according_to', entity: m[1].trim(), type: 'attribution' });
  }

  // 「援引 X」
  const citedFrom = /援引(.{2,40}?)(?:的)?(?:消息|报道|声明|数据)/g;
  while ((m = citedFrom.exec(text)) !== null) {
    signals.push({ signal: 'cited_from', entity: m[1].trim(), type: 'attribution' });
  }

  // 「X 表示/称/指出」
  const statedBy = /(.{2,30}?)(?:表示|称|指出|认为|强调|表示)/g;
  while ((m = statedBy.exec(text)) !== null) {
    const entity = m[1].trim();
    if (entity.length >= 2 && entity.length <= 30) {
      signals.push({ signal: 'stated_by', entity, type: 'attribution' });
    }
  }

  // 「according to X」
  const accToEn = /according to (.{2,40}?),?\s*(?:said|stated|reported|found)/gi;
  while ((m = accToEn.exec(text)) !== null) {
    signals.push({ signal: 'according_to', entity: m[1].trim(), type: 'attribution' });
  }

  return signals;
}

/**
 * 识别 snippet 中的原始出处实体。
 * 返回 [{ entity, type, role }]
 *
 * @param {string} snippet
 * @returns {Array<{entity:string, type:string, role:string}>}
 */
function extractOriginEntities(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return [];
  }
  const entities = [];

  // 机构/报告名称
  const orgPatterns = [
    /(.{2,30}?(?:大学|学院|研究院|研究所|实验室|中心))/g,
    /(.{2,30}?(?:协会|学会|联合会|委员会|组织))/g,
    /((?:MIT|Stanford|Harvard|Oxford|Cambridge|Caltech|ETH|CMU|Berkeley|Princeton|Yale|Columbia|Chicago|Imperial|UCL|Toronto|Melbourne|Tokyo|Kyoto|Seoul|NTU|NUS|HKUST|HKU|Tsinghua|Peking|Fudan|Zhejiang|Shanghai Jiao Tong|USTC|Beihang|Huazhong|UESTC|Xi'an Jia Tong|Harbin|Sun Yat-sen|Tianjin|Xiamen|Sichuan|Shandong|Dalian|Jilin|Nan kai)[\s\w]*)/g,
    /((?:World Bank|IMF|OECD|WTO|WHO|UN|UNESCO|FAO|UNICEF|WTO|WIPO|UNDP|UNEP|UNHCR|IAEA|NATO|APEC|G20|G7|EU|ECB|Federal Reserve|SEC|FDA|NASA|CIA|FBI|NIH|CDC|EPA|USDA|DoD|DOE|HHS|DHS|Treasury|Commerce|Justice|State|Interior|Labor|Transportation|Energy|Education|Veterans|Homeland|SBA|USAID|Peace Corps|Ex-Im Bank|FDIC|NCUA|FHLBB|FSLIC|RTC|OTS|OCC|CFPB|FTC|CFTC|NRC|NLRB|EEOC|MSPB|USPS|GSA|NASA|SBA|USAID|Peace Corps|Ex-Im Bank|FDIC|NCUA|FHLBB|FSLIC|RTC|OTS|OCC|CFPB|FTC|CFTC|NRC|NLRB|EEOC|MSPB|USPS|GSA)[\s\w]*)/g,
    /((?:McKinsey|BCG|Bain|Deloitte|PwC|KPMG|EY|Accenture|IBM|Microsoft|Google|Apple|Amazon|Meta|Tesla|NVIDIA|Intel|AMD|Samsung|TSMC|Huawei|Alibaba|Tencent|Bytedance|JD|Pinduoduo|Baidu|Xiaomi|OPPO|Vivo|OnePlus|Realme|Honor|Meitu|NetEase|Sohu|Sina|Weibo|Zhihu|Douyin|Kuaishou|Bilibili|iQiyi|Youku|Tencent Video|Mango TV|Wasu|BesTV|CIBN|CNTV|CRI|CCTV|CGTN|China Daily|People's Daily|Global Times|Xinhua|China News Service|Economic Daily|Beijing Daily|Wen Wei Po|Ta Kung Pao|South China Morning Post|HKFP|The Standard|Hong Kong Economic Times|Hong Kong Economic Journal|Apple Daily|Sing Tao|Oriental Daily|Hong Kong Commercial Daily|Wen Wei Po|Ta Kung Pao))/g,
  ];
  for (const p of orgPatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      entities.push({ entity: m[1].trim(), type: 'organization', role: 'origin' });
    }
  }

  // 论文/报告名称(通常含年份 + 报告/论文/白皮书)
  const reportPattern = /(.{2,30}?(?:白皮书|蓝皮书|报告|论文|研究|分析|综述|评论|回顾))/g;
  let rm;
  while ((rm = reportPattern.exec(text)) !== null) {
    entities.push({ entity: rm[1].trim(), type: 'report', role: 'origin' });
  }

  return entities;
}

// ── 3. 溯源可信度评分 ────────────────────────────────────────────────

/**
 * 对单条结果计算溯源可信度分数。
 *
 * 溯源分 = wLevel * levelScore
 *        + wCitation * citationScore
 *        + wOrigin * originScore
 *
 * @param {object} result  含 url, snippet, _quality?
 * @returns {{ provenanceScore:number, level:'primary'|'secondary'|'tertiary'|'unknown', citationSignals:object[], originEntities:object[], flags:string[] }}
 */
function provenanceScore(result) {
  const r = result || {};
  const flags = [];

  // 来源层级
  const level = sourceLevel(r.url || '', r.snippet || '');
  const levelScore =
    level === 'primary'
      ? 1.0
      : level === 'secondary'
        ? 0.6
        : level === 'tertiary'
          ? 0.4
          : 0.3;
  if (level === 'primary') {
    flags.push('primary-source');
  } else if (level === 'secondary') {
    flags.push('secondary-source');
  }

  // 引用链信号
  const citationSignals = extractCitationSignals(r.snippet || '');
  const citationScore = Math.min(citationSignals.length * 0.2, 0.6);
  if (citationSignals.length > 0) {
    flags.push('has-citation');
  }

  // 原始出处实体
  const originEntities = extractOriginEntities(r.snippet || '');
  const originScore = Math.min(originEntities.length * 0.15, 0.45);
  if (originEntities.length > 0) {
    flags.push('has-origin-entity');
  }

  // 权重(可配置)
  const wLevel = _float('KHY_PROVENANCE_W_LEVEL', 0.5, 0, 1);
  const wCitation = _float('KHY_PROVENANCE_W_CITATION', 0.3, 0, 1);
  const wOrigin = _float('KHY_PROVENANCE_W_ORIGIN', 0.2, 0, 1);

  const total =
    Math.round((wLevel * levelScore + wCitation * citationScore + wOrigin * originScore) * 1000) /
    1000;

  return {
    provenanceScore: Math.max(0, Math.min(1, total)),
    level,
    citationSignals,
    originEntities,
    flags,
  };
}

// ── 4. 批量溯源 ─────────────────────────────────────────────────────

/**
 * 对结果列表做溯源分析,附加溯源标注。
 *
 * @param {object[]} results  已声明核验的结果
 * @returns {object[]} 溯源后结果(附加 _provenance)
 */
function resolveProvenance(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return results || [];
  }

  // 第一步:计算每条结果的溯源分
  const withProvenance = results.map((r) => {
    const prov = provenanceScore(r);
    return {
      ...r,
      _provenance: prov,
    };
  });

  // 第二步:统计全局溯源信号
  const primaryCount = withProvenance.filter(
    (r) => r._provenance && r._provenance.level === 'primary'
  ).length;
  const secondaryCount = withProvenance.filter(
    (r) => r._provenance && r._provenance.level === 'secondary'
  ).length;
  const tertiaryCount = withProvenance.filter(
    (r) => r._provenance && r._provenance.level === 'tertiary'
  ).length;

  // 第三步:收集所有原始出处实体
  const allOrigins = [];
  for (const r of withProvenance) {
    if (r._provenance && r._provenance.originEntities) {
      for (const e of r._provenance.originEntities) {
        allOrigins.push({ entity: e.entity, type: e.type, source: r.domain || r.url });
      }
    }
  }

  // 第四步:附加全局溯源摘要
  return withProvenance.map((r) => ({
    ...r,
    _provenanceSummary: {
      primaryCount,
      secondaryCount,
      tertiaryCount,
      totalOrigins: allOrigins.length,
      topOrigins: allOrigins.slice(0, 5),
    },
  }));
}

// ── 5. 溯源摘要(供 formatted 输出) ──────────────────────────────────

/**
 * 生成溯源摘要,附加到 formatted 输出末尾。
 * @param {object[]} results  已溯源结果(含 _provenanceSummary)
 * @returns {string}
 */
function formatProvenanceFooter(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  const first = results[0];
  if (!first || !first._provenanceSummary) {
    return '';
  }
  const s = first._provenanceSummary;

  let footer = '\n\n🔗 溯源分析:';
  const parts = [];
  if (s.primaryCount > 0) {
    parts.push(`${s.primaryCount} 条一手来源`);
  }
  if (s.secondaryCount > 0) {
    parts.push(`${s.secondaryCount} 条二手转引`);
  }
  if (s.tertiaryCount > 0) {
    parts.push(`${s.tertiaryCount} 条媒体报道`);
  }
  if (parts.length === 0) {
    return '';
  }
  footer += '\n  来源层级 — ' + parts.join('、');

  // 展示原始出处实体
  if (s.topOrigins && s.topOrigins.length > 0) {
    footer += '\n  原始出处:';
    for (const o of s.topOrigins.slice(0, 3)) {
      footer += `\n    • ${o.entity} (${o.type})`;
    }
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

function _extractPath(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return '';
  }
}

module.exports = {
  sourceLevel,
  extractCitationSignals,
  extractOriginEntities,
  provenanceScore,
  resolveProvenance,
  formatProvenanceFooter,
  // 内部暴露给单测
  __internal: {
    extractHost: _extractHost,
    extractPath: _extractPath,
    isMediaDomain: _isMediaDomain,
  },
};
