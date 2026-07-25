'use strict';

/**
 * cacheMetricsTruth.js — 「缓存命中率如实上报」的确定性单一真源(纯叶子:零 IO、确定性、
 * 绝不抛、可单测)。
 *
 * 立场(用户目标 2026-07-04,截图现场):用户问 khy「你的缓存命中率是多少 / ai 模型的命
 * 中率」,模型答「我不确定……我没有访问实时缓存监控数据的工具」并转移话题。但 khyos 网关
 * **确实**握着这份真值:
 *   ① 本轮响应 usage —— 各适配器已把厂商缓存计费字段规范化成 tokenUsage.cacheReadInputTokens
 *      / cacheWriteInputTokens(见 gateway/adapters/_cacheUsage.js),可即时算出本轮命中率;
 *   ② 跨会话累计 —— cacheEconomyStore 按供应渠道持久化 requests / totalInputTokens /
 *      totalCacheReadTokens,getReport() 给出每渠道 hitRate。
 * 模型对自身运行时遥测装作无从获取,就是另一种「伪装」。此叶子与 [[modelIdentityTruth]] 同
 * 族(都属「不信任模型自报、以网关真值为准」),一前一后两层闭合「杜绝装不知道」:
 *   ① 生成前(A 层):formatMetricsDirective 注入系统提示,告诉模型 khy 确有缓存命中率遥测,
 *      被问时据实回答或指向缓存透明报告,禁止谎称没有监控数据(接线于 selfProfile)。
 *   ② 生成后(B 层):用户问缓存命中率 + 答复搪塞/未给真实数字时,buildMetricsFooter 用网关
 *      **实际遥测**追加一段确定性真值脚注(接线于 aiGateway.finishResult 成功分支)。
 *
 * 零编造铁律:无任何真实遥测(本轮无缓存字段且累计表为空)时 → 降级不追加(footer 返 null),
 * 绝不臆造一个命中率数字。数值缺失只陈述已知部分。
 *
 * 契约:零 IO、确定性、绝不抛。真实遥测由 IO 壳(finishResult / selfProfile)读出后传入,本
 * 叶子只做纯计算与文案。env 门控 KHY_CACHE_METRICS_TRUTH(默认开,仅显式 0/false/off/no 关;
 * 关闭后 isEnabled 返 false、footer 与 directive 构造器返 null 或空串 → 两接缝逐字节回退到「不
 * 注入指令 / 不追加脚注」)。父门控经 flagRegistry 集中判定,fail-soft 回退本地 CANON。
 *
 * @module services/cacheMetricsTruth
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_CACHE_METRICS_TRUTH', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_CACHE_METRICS_TRUTH;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 真值脚注 / 指令块的首行标记,用于去重(接缝据此判断是否已追加过本段)。
const METRICS_MARKER = '【khyos 缓存命中率';

// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../utils/finiteNumber').toPositiveOr0;

// ── 用户是否在问「缓存命中率是多少」─────────────────────────────────────────────
// 「命中率」在 khy CLI 语境里几乎专指缓存命中率(截图两问:「你的缓存命中率是多少」/「ai 模型
// 的命中率」)。保守但覆盖两种问法:显式「缓存命中率」;或「命中率」搭自指/询问词。
const _METRICS_QUESTION_RES = [
  // 显式缓存命中率(缓存……命中率 / 命中率……缓存 / cache hit rate)
  /缓存.{0,6}命中率|命中率.{0,6}缓存/,
  /\bcache\s*hit\s*rate\b/i,
  // 命中率 + 询问词(是多少 / 多少 / 多高 / 怎么样 / 如何)
  /命中率.{0,8}(是?多少|多高|怎么样|如何|几何)/,
  /(多少|多高).{0,8}命中率/,
  // 命中率 + 自指/系统指涉(你/你的/khy/ai 模型/模型/系统/当前会话/本次)
  /(你|你的|你们|khy(os)?|ai\s*模型|模型|系统|当前(会话|轮)|本(次|轮|会话)|会话)\s*的?\s*命中率/i,
  // 英文:your/current cache/hit rate ; what is the hit rate
  /\b(your|current|the)\s+(cache\s+)?hit\s*rate\b/i,
  /\bhit\s*rate\b.{0,12}\b(what|how\s+(much|high))\b/i,
  /\b(what|how\s+(much|high))\b.{0,12}\bhit\s*rate\b/i,
];

/**
 * 用户这句话是否在问「(khy 自己的)缓存命中率是多少」。零假阳性偏向:要求出现「命中率 /
 * hit rate」这一较专的术语。空/非串 → false。
 * @param {string} text
 * @returns {boolean}
 */
function isCacheMetricsQuestion(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return false;
  try {
    return _METRICS_QUESTION_RES.some((re) => re.test(s));
  } catch {
    return false;
  }
}

// ── 答复是否搪塞(装作无从获取,而非给出真实数字)──────────────────────────────
// 搪塞标志:自称不确定 / 无访问权限 / 无监控工具 / 一味「取决于……」而不给数字。
const _DEFLECTION_RES = [
  /我?\s*不(确定|清楚|知道)/,
  /无法(获取|确定|知道|得知|提供|访问)/,
  /没有(访问|获取)?.{0,10}(工具|数据|权限|监控|指标)/,
  /取决于/,
  /\bi\s*(do\s*not|don'?t|am\s*not\s*sure|can'?t|cannot)\b/i,
  /\b(no|without)\s+(access|way|tool|tools|visibility)\b/i,
  /\bdepends\s+on\b/i,
];

// 答复里是否已含一个具体的百分比数字(如「63%」/「58 %」)——已给真实数字则不视为搪塞。
const _PERCENT_RE = /\d{1,3}\s*%|\d{1,3}\s*percent\b/i;

/**
 * 判定答复相对「真有遥测可报」是否属于「搪塞 / 未给真实数字」。真值全无 → 无从补 → 不介入。
 * 判据(有真实遥测且满足其一即 deflected):
 *   - 答复命中搪塞标志(不确定 / 无访问 / 取决于……);
 *   - 或答复通篇没有任何具体百分比数字(对「你的命中率是多少」避而不给数)。
 * 答复已含具体百分比 → 视为已作答(stated),不追加(避免与真人写的数字重复堆叠)。
 * @param {string} answer
 * @param {{hasData:boolean}} metrics  由 resolveMetrics 得出;hasData=false → no-data
 * @returns {{deflected:boolean, reason:string}}
 */
function detectDeflection(answer, metrics) {
  if (!metrics || !metrics.hasData) return { deflected: false, reason: 'no-data' };
  const ans = String(answer == null ? '' : answer);
  let hasDeflection = false;
  for (const re of _DEFLECTION_RES) {
    try { if (re.test(ans)) { hasDeflection = true; break; } } catch { /* skip */ }
  }
  const hasPercent = _PERCENT_RE.test(ans);
  if (hasPercent && !hasDeflection) return { deflected: false, reason: 'stated' };
  if (hasDeflection) return { deflected: true, reason: 'deflected' };
  if (!hasPercent) return { deflected: true, reason: 'no-figure' };
  return { deflected: false, reason: 'stated' };
}

/** 本轮 usage → 命中率百分比(0..100),或 null(无缓存字段/无输入)。 */
function _turnHitRate(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = _num(usage.inputTokens != null ? usage.inputTokens : usage.input_tokens);
  const cacheWrite = _num(
    usage.cacheWriteInputTokens != null ? usage.cacheWriteInputTokens : usage.cache_creation_input_tokens
  );
  const cacheRead = _num(
    usage.cacheReadInputTokens != null ? usage.cacheReadInputTokens : usage.cache_read_input_tokens
  );
  if (cacheRead === 0 && cacheWrite === 0) return null; // 无缓存数据
  const total = input + cacheWrite + cacheRead;
  if (total === 0) return null;
  return (cacheRead / total) * 100;
}

/** 归一渠道键。 */
// 收敛到 utils/trimLowerNullish 单一真源(逐字节委托,调用点不变)
const _key = require('../utils/trimLowerNullish');

/**
 * 把网关的真实遥测归一成规范结构。全部纯计算,IO 壳负责读出后传入。
 * @param {object} raw
 * @param {object} [raw.turnUsage]    本轮 result.tokenUsage(规范缓存字段)
 * @param {object} [raw.report]       cacheEconomyStore.getReport() 结果({adapters:{key:{hitRate,requests,verdict,...}}})
 * @param {string} [raw.activeAdapter] 当前实际路由的渠道键(用于标注「当前渠道」)
 * @returns {{turnRate:number|null, adapters:Array, activeKey:string, hasData:boolean}}
 *   adapters: [{key, ratePct(0..100), requests, verdict}],按 requests 降序,仅收录有请求样本者。
 */
function resolveMetrics(raw = {}) {
  const r = raw || {};
  const turnRate = _turnHitRate(r.turnUsage);
  const activeKey = _key(r.activeAdapter);

  const adapters = [];
  try {
    const rep = r.report && typeof r.report === 'object' ? r.report : null;
    const table = rep && rep.adapters && typeof rep.adapters === 'object' ? rep.adapters : {};
    for (const [k, entry] of Object.entries(table)) {
      if (!entry || typeof entry !== 'object') continue;
      const requests = _num(entry.requests);
      if (requests <= 0) continue; // 无样本 → 跳过(不臆造)
      // getReport() 的 hitRate 是 0..1 小数;缺则由 totalCacheReadTokens/totalInputTokens 兜算。
      let frac = Number(entry.hitRate);
      if (!Number.isFinite(frac)) {
        const ti = _num(entry.totalInputTokens);
        frac = ti > 0 ? _num(entry.totalCacheReadTokens) / ti : 0;
      }
      adapters.push({
        key: _key(k),
        ratePct: Math.max(0, Math.min(100, frac * 100)),
        requests,
        verdict: String(entry.verdict || '').trim(),
      });
    }
    adapters.sort((a, b) => b.requests - a.requests);
  } catch { /* fail-soft:遥测坏 → 空表 */ }

  const hasData = turnRate !== null || adapters.length > 0;
  return { turnRate, adapters, activeKey, hasData };
}

/** 依据用户提问文本粗判 locale:含 CJK → 'zh',否则 'en'。 */
// 收敛到 utils/pickLocale 单一真源(逐字节委托,调用点不变)
const pickLocale = require('../utils/pickLocale');

/**
 * 从网关调用的 prompt / options 挑出「用户当前这句话」。委托共享叶子 latestUserText(修「footer
 * 每轮都来」:网关传入的 prompt 是整条拍平会话,含引用触发问句的 system 指令,会让
 * isCacheMetricsQuestion 每轮自命中)。门控关 / 叶子不可用 → 逐字节回退原「prompt 优先」行为。
 * @param {string} prompt
 * @param {object} [options]
 * @returns {string}
 */
const pickUserText = require('../utils/pickUserTextSafe');

/** 找到当前渠道的累计条目(若在表内)。 */
function _findActive(adapters, activeKey) {
  if (!activeKey) return null;
  return adapters.find((a) => a.key === activeKey) || null;
}

/**
 * 真值脚注:陈述本轮命中率 + 各渠道累计命中率。门控关 / 无任何遥测 → null(接缝字节回退)。
 * 只陈述已知部分,数值缺失不臆造。
 * @param {{turnRate:number|null, adapters:Array, activeKey:string, hasData:boolean}} metrics
 * @param {object} [opts]  {locale, env}
 * @returns {string|null}
 */
function buildMetricsFooter(metrics, opts = {}) {
  if (!isEnabled(opts.env)) return null;
  const m = metrics && typeof metrics === 'object' ? metrics : null;
  if (!m || !m.hasData) return null;
  const locale = opts.locale === 'en' ? 'en' : 'zh';
  const active = _findActive(m.adapters || [], m.activeKey);
  const topN = (m.adapters || []).slice(0, 3);

  if (locale === 'en') {
    const clauses = [];
    if (m.turnRate !== null) clauses.push(`this turn's cache hit rate is ${Math.round(m.turnRate)}% (from this response's usage)`);
    if (active) {
      clauses.push(`the active channel "${active.key}" has a ${Math.round(active.ratePct)}% cumulative hit rate over ${active.requests} requests`);
    } else if (topN.length) {
      const parts = topN.map((a) => `${a.key} ${Math.round(a.ratePct)}% (${a.requests} req)`);
      clauses.push(`cumulative by channel — ${parts.join('; ')}`);
    }
    if (!clauses.length) return null;
    return `\n\n${METRICS_MARKER} · verified】${clauses.join('; ')}. Source: the khy gateway cache-billing probe. khyos reports its own runtime telemetry truthfully instead of claiming it has no monitoring access.`;
  }

  const clauses = [];
  if (m.turnRate !== null) clauses.push(`本轮缓存命中率 ${Math.round(m.turnRate)}%(来自本次响应 usage)`);
  if (active) {
    clauses.push(`当前渠道「${active.key}」累计命中率 ${Math.round(active.ratePct)}%(共 ${active.requests} 次请求)`);
  } else if (topN.length) {
    const parts = topN.map((a) => `${a.key} ${Math.round(a.ratePct)}%(${a.requests} 次)`);
    clauses.push(`各渠道累计 —— ${parts.join(';')}`);
  }
  if (!clauses.length) return null;
  return `\n\n${METRICS_MARKER} · 确定性核对】${clauses.join(';')}。数据源:khy 网关缓存计费探针(cacheEconomyStore),khyos 对自身运行时遥测如实上报,不谎称没有监控数据。`;
}

/**
 * 系统提示指令块(A 层)。门控关 → ''(不注入,字节回退)。告诉模型 khy 确有缓存命中率遥测,
 * 被问时据实回答或指向缓存透明报告,禁止谎称没有监控数据。
 * @param {object} [opts]  {locale, env}
 * @returns {string}
 */
function formatMetricsDirective(opts = {}) {
  if (!isEnabled(opts.env)) return '';
  const locale = opts.locale === 'en' ? 'en' : 'zh';

  if (locale === 'en') {
    return [
      '## Cache hit rate is observable (do not feign ignorance)',
      '- khyos DOES track its own cache hit rate: this turn\'s value comes from the response usage (cache_read / cache_creation tokens), and per-channel cumulative rates are kept by the gateway cache-billing probe.',
      '- When the user asks what your cache hit rate is, answer with that REAL figure, or point to the cache transparency report. Do NOT claim you have "no access to real-time monitoring tools".',
      '- If the current session truly has no cache data yet, say so plainly (e.g. no cache-served tokens observed yet) rather than deflecting to generic "it depends".',
    ].join('\n');
  }

  return [
    '## 缓存命中率可观测(不要装作无从获取)',
    '- khyos 确实在记录自身缓存命中率:本轮命中率来自本次响应的 usage(cache_read / cache_creation token),各供应渠道的累计命中率由网关缓存计费探针持续记录。',
    '- 当用户问「你的缓存命中率是多少 / 模型的命中率」时,据此如实回答那个真实数字,或指向缓存透明报告;不要谎称「没有访问实时监控数据的工具」。',
    '- 若当前会话确实尚无缓存数据,直说「本会话暂未观测到缓存命中」,而不是含糊地「取决于配置……」搪塞。',
  ].join('\n');
}

module.exports = {
  isEnabled,
  METRICS_MARKER,
  isCacheMetricsQuestion,
  detectDeflection,
  resolveMetrics,
  pickLocale,
  pickUserText,
  buildMetricsFooter,
  formatMetricsDirective,
};
