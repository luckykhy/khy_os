'use strict';

/**
 * searchClaimVerifier.js — 搜索结果事实声明提取与交叉核验纯叶子(goal 2026-09-05
 * 「对抗式核验:事实声明级核验」)。
 *
 * 上一阶段的 searchAdversarialVerifier 解决了「来源级」可信度问题(推广/SEO/信息茧房),
 * 但搜索系统仍缺少「声明级」核验:不同来源对同一事实的描述是否一致?哪些声明有
 * 多源佐证?哪些是单一来源的孤证?本叶子从事故摘要中提取可验证的事实声明,
 * 并在多源间做交叉核验:
 *
 *   1. 事实声明提取(Claim Extraction)
 *      - 从 snippet 中提取数值型声明(日期/版本/数量/百分比)
 *      - 提取实体-属性对(「Python 3.12 发布于 2024-10-02」)
 *      - 提取因果/比较声明(「X 比 Y 快 30%」)
 *
 *   2. 声明级交叉核验(Claim-Level Cross-Verification)
 *      - 同一声明被多个独立来源提及 → 高可信度
 *      - 仅单一来源提及 → 标记为「孤证」
 *      - 数值冲突检测(不同来源给出不同数字)
 *
 *   3. 声明共识度评分(Claim Consensus Score)
 *      - 综合「声明频次 + 来源权威性 + 数值一致性」
 *      - 输出每条声明的共识度 + 冲突列表
 *
 * 设计原则(与 searchQualityEnhancer / searchAdversarialVerifier 一脉相承):
 *   - 纯叶子:零 IO、确定性、绝不抛(输入强转)
 *   - 不丢结果:声明核验信号用于标注,不删除结果
 *   - 可配置:阈值一律走 env(KHY_CLAIM_*)
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

// ── 1. 事实声明提取 ─────────────────────────────────────────────────

/**
 * 从 snippet 中提取数值型声明。
 * 返回 [{ type, value, unit, raw, context }]
 *
 * @param {string} snippet
 * @returns {Array<{type:string, value:string, unit:string, raw:string, context:string}>}
 */
function extractNumericClaims(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return [];
  }
  const claims = [];

  // 日期声明
  const datePatterns = [
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g,
    /(\d{4})年(\d{1,2})月(\d{1,2})日?/g,
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/gi,
  ];
  for (const p of datePatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      claims.push({
        type: 'date',
        value: m[0],
        unit: '',
        raw: m[0],
        context: _context(text, m.index, m[0].length),
      });
    }
  }

  // 版本号声明
  const versionPattern = /v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-.]?(alpha|beta|rc|stable))?/gi;
  let vm;
  while ((vm = versionPattern.exec(text)) !== null) {
    // 过滤掉 IP 地址 / 年份
    const major = parseInt(vm[1], 10);
    if (major >= 1900 && major <= 2100 && vm[2] <= 12) {
      continue; // 可能是日期
    }
    claims.push({
      type: 'version',
      value: vm[0],
      unit: '',
      raw: vm[0],
      context: _context(text, vm.index, vm[0].length),
    });
  }

  // 百分比声明
  const percentPattern = /(\d+(?:\.\d+)?)\s*%/g;
  let pm;
  while ((pm = percentPattern.exec(text)) !== null) {
    claims.push({
      type: 'percentage',
      value: pm[1],
      unit: '%',
      raw: pm[0],
      context: _context(text, pm.index, pm[0].length),
    });
  }

  // 数量声明(带单位)
  const quantityPattern = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*(万|亿|百万|千|亿|bytes?|kb|mb|gb|tb|ms|s|分钟|小时|天|年|人|次|个)/gi;
  let qm;
  while ((qm = quantityPattern.exec(text)) !== null) {
    claims.push({
      type: 'quantity',
      value: qm[1].replace(/,/g, ''),
      unit: qm[2],
      raw: qm[0],
      context: _context(text, qm.index, qm[0].length),
    });
  }

  return claims;
}

/**
 * 从 snippet 中提取实体-属性声明。
 * 返回 [{ entity, attribute, value, raw }]
 *
 * @param {string} snippet
 * @returns {Array<{entity:string, attribute:string, value:string, raw:string}>}
 */
function extractEntityClaims(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return [];
  }
  const claims = [];

  // 「X 发布于 Y」「X 发布于 2024 年」
  const releasePattern = /(.{2,30}?)\s*(?:发布|推出|上市|推出|首发|问世)\s*(?:于|在)?\s*(\d{4}[-/年]\d{1,2}[-/月]?\d{0,2})/g;
  let rm;
  while ((rm = releasePattern.exec(text)) !== null) {
    claims.push({
      entity: rm[1].trim(),
      attribute: 'release_date',
      value: rm[2],
      raw: rm[0],
    });
  }

  // 「X 是 Y」「X 是一个 Y」
  const isAPattern = /(.{2,30}?)\s*是\s*(?:一个|一款|一种|一家|世界)?\s*(.{2,50}?)(?:[。，,；;]|$)/g;
  let im;
  while ((im = isAPattern.exec(text)) !== null) {
    const entity = im[1].trim();
    const value = im[2].trim();
    // 过滤过短 / 过长的实体
    if (entity.length < 2 || entity.length > 30 || value.length > 50) {
      continue;
    }
    claims.push({
      entity,
      attribute: 'is_a',
      value,
      raw: im[0],
    });
  }

  return claims;
}

/**
 * 从 snippet 中提取比较/因果声明。
 * 返回 [{ subject, comparator, baseline, metric, raw }]
 *
 * @param {string} snippet
 * @returns {Array<{subject:string, comparator:string, baseline:string, metric:string, raw:string}>}
 */
function extractComparisonClaims(snippet) {
  const text = String(snippet || '').trim();
  if (!text) {
    return [];
  }
  const claims = [];

  // 「X 比 Y 快/好/大 Z%」
  const compPattern = /(.{2,20}?)比(.{2,20}?)(快|慢|大|小|高|低|好|差|强|弱|多|少)\s*(\d+(?:\.\d+)?)\s*(%|倍|倍|倍)/g;
  let cm;
  while ((cm = compPattern.exec(text)) !== null) {
    claims.push({
      subject: cm[1].trim(),
      comparator: cm[2].trim(),
      baseline: cm[3],
      metric: cm[4] + cm[5],
      raw: cm[0],
    });
  }

  // 「X 导致 Y」「X 使得 Y」
  const causePattern = /(.{2,20}?)(?:导致|使得|引起|造成|带来)(.{2,30}?)(?:[。，,；;]|$)/g;
  let cem;
  while ((cem = causePattern.exec(text)) !== null) {
    claims.push({
      subject: cem[1].trim(),
      comparator: 'causes',
      baseline: cem[2].trim(),
      metric: '',
      raw: cem[0],
    });
  }

  return claims;
}

/**
 * 提取所有类型的声明。
 * @param {string} snippet
 * @returns {{ numeric:object[], entity:object[], comparison:object[] }}
 */
function extractAllClaims(snippet) {
  return {
    numeric: extractNumericClaims(snippet),
    entity: extractEntityClaims(snippet),
    comparison: extractComparisonClaims(snippet),
  };
}

// ── 2. 声明级交叉核验 ────────────────────────────────────────────────

/**
 * 对数值型声明做归一化,用于跨来源比较。
 * 返回可比较的字符串键。
 * @param {object} claim
 * @returns {string}
 */
function _claimKey(claim) {
  if (!claim) {
    return '';
  }
  switch (claim.type) {
    case 'date':
      // 归一化日期:2024-01-15 → 20240115
      return `date:${claim.value.replace(/[-/年日]/g, '').replace(/月/, '')}`;
    case 'version':
      return `ver:${claim.value.toLowerCase()}`;
    case 'percentage':
      return `pct:${claim.value}`;
    case 'quantity':
      return `qty:${claim.value}${claim.unit}`;
    default:
      return `${claim.type}:${claim.value}`;
  }
}

/**
 * 对单条结果提取所有声明并附加到结果上。
 * @param {object} result
 * @returns {object} 附加 _claims 字段的结果
 */
function attachClaims(result) {
  const r = result || {};
  const claims = extractAllClaims(r.snippet || '');
  return {
    ...r,
    _claims: claims,
    _claimCount: claims.numeric.length + claims.entity.length + claims.comparison.length,
  };
}

/**
 * 跨来源声明核验:对多个结果的声明做交叉比对。
 *
 * 返回:
 *   - verifiedClaims: 被 ≥2 来源提及的声明(高可信度)
 *   - singleSourceClaims: 仅单一来源提及的声明(孤证)
 *   - conflictingClaims: 数值冲突的声明
 *
 * @param {object[]} results  已 attachClaims 的结果
 * @returns {{ verified:object[], single:object[], conflicts:object[] }}
 */
function crossVerifyClaims(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { verified: [], single: [], conflicts: [] };
  }

  // 收集所有声明
  const claimIndex = new Map(); // key -> [{ result, claim, source }]
  for (const r of results) {
    if (!r || !r._claims) {
      continue;
    }
    const source = r.domain || r.url || '';
    for (const claim of [
      ...(r._claims.numeric || []),
      ...(r._claims.entity || []),
      ...(r._claims.comparison || []),
    ]) {
      const key = _claimKey(claim);
      if (!key) {
        continue;
      }
      if (!claimIndex.has(key)) {
        claimIndex.set(key, []);
      }
      claimIndex.get(key).push({ result: r, claim, source });
    }
  }

  const verified = [];
  const single = [];
  const conflicts = [];

  for (const [key, entries] of claimIndex.entries()) {
    // 去重来源
    const uniqueSources = new Set(entries.map((e) => e.source));
    const sourceCount = uniqueSources.size;

    if (sourceCount >= 2) {
      // 多源佐证
      const firstClaim = entries[0].claim;
      verified.push({
        key,
        claim: firstClaim,
        sourceCount,
        sources: [...uniqueSources],
        entries: entries.slice(0, 5), // 最多保留 5 个佐证
      });
    } else if (sourceCount === 1) {
      single.push({
        key,
        claim: entries[0].claim,
        source: entries[0].source,
      });
    }
  }

  // 数值冲突检测:同一实体/属性,不同数值
  const entityIndex = new Map();
  for (const r of results) {
    if (!r || !r._claims) {
      continue;
    }
    for (const claim of r._claims.entity || []) {
      const ek = `${claim.entity}::${claim.attribute}`;
      if (!entityIndex.has(ek)) {
        entityIndex.set(ek, []);
      }
      entityIndex.get(ek).push({ value: claim.value, source: r.domain || r.url });
    }
  }
  for (const [ek, entries] of entityIndex.entries()) {
    const uniqueValues = new Set(entries.map((e) => e.value));
    if (uniqueValues.size > 1) {
      conflicts.push({
        key: ek,
        values: [...uniqueValues],
        entries,
      });
    }
  }

  return { verified, single, conflicts };
}

// ── 3. 声明共识度评分 ────────────────────────────────────────────────

/**
 * 对单条结果计算声明共识度分数。
 *
 * 共识度 = 该结果中「被多源佐证的声明数」 / 「该结果总声明数」
 * → 结果中佐证声明占比越高,共识度越高
 *
 * @param {object} result  已 attachClaims
 * @param {object} verifiedKeys  已验证声明 key 集合
 * @returns {number} 0~1
 */
function claimConsensusScore(result, verifiedKeys) {
  if (!result || !result._claims || !verifiedKeys) {
    return 0;
  }
  const allClaims = [
    ...(result._claims.numeric || []),
    ...(result._claims.entity || []),
    ...(result._claims.comparison || []),
  ];
  if (allClaims.length === 0) {
    return 0;
  }
  let verifiedCount = 0;
  for (const claim of allClaims) {
    const key = _claimKey(claim);
    if (verifiedKeys.has(key)) {
      verifiedCount += 1;
    }
  }
  return Math.round((verifiedCount / allClaims.length) * 1000) / 1000;
}

// ── 4. 批量核验 ─────────────────────────────────────────────────────

/**
 * 对结果列表做声明级核验,附加声明 + 共识度标注。
 *
 * @param {object[]} results  已对抗式核验的结果(含 _confidence)
 * @returns {object[]} 核验后结果(附加 _claims + _claimConsensus)
 */
function verifyClaims(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return results || [];
  }

  // 第一步:提取声明
  const withClaims = results.map(attachClaims);

  // 第二步:交叉核验
  const { verified, single, conflicts } = crossVerifyClaims(withClaims);

  // 第三步:构建已验证 key 集合
  const verifiedKeys = new Set(verified.map((v) => v.key));

  // 第四步:计算每条结果的声明共识度
  const withConsensus = withClaims.map((r) => {
    const consensus = claimConsensusScore(r, verifiedKeys);
    return {
      ...r,
      _claimConsensus: consensus,
    };
  });

  // 第五步:附加全局声明核验摘要
  return withConsensus.map((r) => ({
    ...r,
    _claimVerification: {
      verifiedClaims: verified.length,
      singleSourceClaims: single.length,
      conflictingClaims: conflicts.length,
      topVerified: verified.slice(0, 3).map((v) => ({
        claim: v.claim,
        sourceCount: v.sourceCount,
      })),
      conflicts: conflicts.slice(0, 3).map((c) => ({
        key: c.key,
        values: c.values,
      })),
    },
  }));
}

// ── 5. 核验摘要(供 formatted 输出) ──────────────────────────────────

/**
 * 生成声明核验摘要,附加到 formatted 输出末尾。
 * @param {object[]} results  已声明核验结果(含 _claimVerification)
 * @returns {string}
 */
function formatClaimFooter(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  const first = results[0];
  if (!first || !first._claimVerification) {
    return '';
  }
  const v = first._claimVerification;

  let footer = '\n\n📋 声明核验:';
  const parts = [];
  if (v.verifiedClaims > 0) {
    parts.push(`${v.verifiedClaims} 条多源佐证声明`);
  }
  if (v.singleSourceClaims > 0) {
    parts.push(`${v.singleSourceClaims} 条孤证声明`);
  }
  if (v.conflictingClaims > 0) {
    parts.push(`${v.conflictingClaims} 处数值冲突`);
  }
  if (parts.length === 0) {
    return '';
  }
  footer += '\n  ' + parts.join('、');

  // 展示 top 佐证声明
  if (v.topVerified && v.topVerified.length > 0) {
    footer += '\n  佐证声明:';
    for (const tv of v.topVerified) {
      const claimStr = _formatClaim(tv.claim);
      if (claimStr) {
        footer += `\n    ✓ ${claimStr} (${tv.sourceCount} 源)`;
      }
    }
  }

  // 展示冲突
  if (v.conflicts && v.conflicts.length > 0) {
    footer += '\n  ⚠️ 冲突:';
    for (const c of v.conflicts) {
      footer += `\n    ${c.key}: ${c.values.join(' vs ')}`;
    }
  }

  return footer;
}

// ── 工具函数 ─────────────────────────────────────────────────────────

function _context(text, start, length) {
  const ctxStart = Math.max(0, start - 20);
  const ctxEnd = Math.min(text.length, start + length + 20);
  return text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();
}

function _formatClaim(claim) {
  if (!claim) {
    return '';
  }
  if (claim.type === 'date' || claim.type === 'version' || claim.type === 'percentage' || claim.type === 'quantity') {
    return claim.raw;
  }
  if (claim.entity && claim.value) {
    return `${claim.entity} = ${claim.value}`;
  }
  if (claim.raw) {
    return claim.raw;
  }
  return '';
}

module.exports = {
  extractNumericClaims,
  extractEntityClaims,
  extractComparisonClaims,
  extractAllClaims,
  attachClaims,
  crossVerifyClaims,
  claimConsensusScore,
  verifyClaims,
  formatClaimFooter,
  // 内部暴露给单测
  __internal: {
    claimKey: _claimKey,
    context: _context,
    formatClaim: _formatClaim,
  },
};
