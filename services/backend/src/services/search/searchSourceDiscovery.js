'use strict';

/**
 * searchSourceDiscovery.js — 搜索「源发现」单一真源(goal 2026-06-26
 * 「搜索工具都是固定站点,要是出现什么新的站点 khy 怎么发现呢」)。
 *
 * 现状:webSearchService 的 ENGINE_REGISTRY 是 5 个写死的免 key 抓取引擎(百度 / Bing 中国 /
 * DuckDuckGo / 搜狗 / 360),只能改源码新增,运行期既不能注册新站点,也不会从结果里注意到新
 * 冒头的权威源。本叶子从两个方向打开这个锁:
 *
 *   1. 固定站点 → 运行期可扩展(loadDynamicEngines / buildEngineUrl)
 *      允许在环境变量 KHY_SEARCH_EXTRA_ENGINES 或数据家下的 search_engines.json 里**声明**额外
 *      引擎,无需改源码即可并入扇出。每个声明复用一个已验证的解析器家族
 *      (baidu | bing | duckduckgo | sogou | so360 | generic),URL 用 {q} / {fresh} 占位。
 *      generic 解析器(在 webSearchService 侧实现)兜底任何**全新**的搜索站点。
 *
 *   2. 怎么「发现」新站点 → 从结果里挖(discoverEmergingSources / suggestSiteQueries)
 *      跨引擎反复出现、排名靠前、却不在已知源集合里的域名,就是一个新冒出来的权威源。本叶子把
 *      它们识别、打分、排序;suggestSiteQueries 据此产出 `site:host query` 跟进检索,
 *      formatDiscoveryFooter 把它们附到搜索结果末尾,让模型(以及用户)能主动深入新站点。
 *
 * 纯叶子:零 IO、确定性、绝不抛(配置文本由缝接侧读盘后注入)。env 门控
 * KHY_SEARCH_SOURCE_DISCOVERY(默认开,仅显式 0/false/off 关闭)。
 */

// ── env 门控 ─────────────────────────────────────────────────────────
// 收敛到 utils/envOnByName 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/envOnByName');
function isEnabled(env) { return _envOn(env, 'KHY_SEARCH_SOURCE_DISCOVERY'); }

// 动态引擎允许复用的解析器家族(与 webSearchService 内置解析器一一对应;generic 兜底)。
const KNOWN_PARSERS = new Set(['baidu', 'bing', 'duckduckgo', 'sogou', 'so360', 'generic']);

// 「老面孔」:内置引擎自身的域名 + 极常见的大众门户。出现在结果里不算「新发现」,
// 避免把维基 / 知乎这类常驻内容源当成新冒头的站点而刷屏。保守起见只列最常见的,
// 其余域名一律当作潜在新源候选(再由共识 / 频次 / 排名过滤)。
const KNOWN_HOSTS = new Set([
  'baidu.com', 'baike.baidu.com', 'zhidao.baidu.com',
  'bing.com', 'cn.bing.com',
  'duckduckgo.com', 'sogou.com', 'so.com', '360.cn',
  'google.com', 'google.com.hk',
  'zhihu.com', 'zhuanlan.zhihu.com',
  'wikipedia.org', 'zh.wikipedia.org', 'en.wikipedia.org',
  'csdn.net', 'blog.csdn.net', 'jianshu.com', 'cnblogs.com',
]);

// ── 1. 动态引擎注册 ─────────────────────────────────────────────────

/**
 * 归一化并校验单个引擎声明。非法 → null(绝不抛)。
 * @param {object} d  { name, urlTemplate|url, parser?, weight? }
 * @returns {{name:string, urlTemplate:string, parser:string, weight:number}|null}
 */
function _normalizeEngine(d) {
  if (!d || typeof d !== 'object') return null;
  const name = String(d.name || '').trim().toLowerCase();
  // 引擎名:字母数字起头,允许 - _,长度 ≤ 31,避免污染日志 / 注册表键。
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name)) return null;

  const urlTemplate = String(d.urlTemplate || d.url || '').trim();
  if (!/^https?:\/\//i.test(urlTemplate)) return null;       // 必须是 http(s) 端点
  if (!/\{q\}/.test(urlTemplate)) return null;               // 必须含查询占位 {q}

  let parser = String(d.parser || 'generic').trim().toLowerCase();
  if (parser === 'bing-cn') parser = 'bing';
  if (!KNOWN_PARSERS.has(parser)) parser = 'generic';        // 未知解析器 → generic 兜底

  let weight = Number(d.weight);
  if (!Number.isFinite(weight)) weight = 0.5;
  weight = Math.max(0.1, Math.min(1, weight));               // 夹取到 [0.1, 1]

  return { name, urlTemplate, parser, weight };
}

/**
 * 从注入的来源(env 字符串 / 配置文本)装载动态引擎声明。配置文本接受两种形态:
 * 顶层数组 `[{...}]`,或 `{ "engines": [{...}] }`。非法 JSON / 非法项一律静默跳过。
 * 同名去重(先到先得);绝不与内置引擎冲突由缝接侧合并时处理(此处不知道内置集合)。
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {string} [opts.configText]  数据家 search_engines.json 的原始文本(缝接侧读盘注入)
 * @returns {Array<{name:string, urlTemplate:string, parser:string, weight:number, origin:string}>}
 */
function loadDynamicEngines(opts = {}) {
  if (!isEnabled(opts.env)) return [];
  const out = [];
  const seen = new Set();

  const _ingest = (raw, origin) => {
    let parsed = raw;
    if (typeof raw === 'string') {
      const t = raw.trim();
      if (!t) return;
      try { parsed = JSON.parse(t); } catch { return; }
    }
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.engines)) parsed = parsed.engines;
    if (!Array.isArray(parsed)) return;
    for (const d of parsed) {
      const norm = _normalizeEngine(d);
      if (norm && !seen.has(norm.name)) { seen.add(norm.name); out.push({ ...norm, origin }); }
    }
  };

  const env = opts.env || process.env || {};
  if (env.KHY_SEARCH_EXTRA_ENGINES) _ingest(env.KHY_SEARCH_EXTRA_ENGINES, 'env');
  if (opts.configText) _ingest(opts.configText, 'config');
  return out;
}

/**
 * 把查询(和可选的时间过滤参数串)填进引擎 URL 模板。
 *   {q}     → 经 encodeURIComponent 的查询(截断到 200 字符,与内置引擎一致)
 *   {fresh} → 时间过滤 query 串(不含前导 & / ?);模板未含 {fresh} 时,若给了 fresh
 *             则按需以 & 或 ? 追加。
 * @param {object} descriptor  loadDynamicEngines 的一项
 * @param {string} query
 * @param {string} [freshParam]  形如 "df=w" 的 query 片段(不含前导分隔符)
 * @returns {string}
 */
function buildEngineUrl(descriptor, query, freshParam) {
  if (!descriptor || !descriptor.urlTemplate) return '';
  const q = encodeURIComponent(String(query || '').slice(0, 200));
  let url = String(descriptor.urlTemplate).replace(/\{q\}/g, q);
  const fresh = String(freshParam || '').replace(/^[?&]/, '');
  if (/\{fresh\}/.test(url)) {
    url = url.replace(/\{fresh\}/g, fresh);
  } else if (fresh) {
    url += (url.includes('?') ? '&' : '?') + fresh;
  }
  return url;
}

// ── 2. 从结果发现新冒头的权威源 ─────────────────────────────────────

/** 取归一化主机名(去 www. / 小写)。无法解析 → ''。 */
function _host(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return ''; }
}

/** host 是否已知(精确或作为已知域的子域)。无法解析的 host 视为已知(不当新源)。 */
function _isKnownHost(host, known) {
  if (!host) return true;
  const set = known instanceof Set ? known : KNOWN_HOSTS;
  if (set.has(host)) return true;
  for (const k of set) {
    if (host === k || host.endsWith('.' + k)) return true;
  }
  return false;
}

/** 给一个候选源打分:跨引擎共识 > 出现频次 > 排名靠前。确定性,无随机。 */
function _scoreSource(rec, total) {
  const consensus = rec.maxEngineCount >= 2 ? 2 : 0;           // 被≥2引擎收录是最强信号
  const freq = Math.min(rec.hits, 5) * 0.5;                    // 出现次数(封顶,避免单站刷屏)
  const rankBoost = total > 0 ? (1 - rec.bestRank / total) : 0; // 越靠前越高
  return consensus + freq + rankBoost;
}

/**
 * 从一批(已融合 / 去重的)搜索结果里,挖出「新冒头的权威源」:不在已知源集合、却跨引擎
 * 反复出现或排名靠前的域名。绝不改入参;门控关闭 → 返回 []。
 * @param {Array} results  每项形如 { url|link, title, engineCount? }
 * @param {object} [opts]
 * @param {Set<string>} [opts.knownHosts]  覆盖默认 KNOWN_HOSTS(缝接侧可并入内置引擎域名)
 * @param {number} [opts.max]  返回上限(默认 5)
 * @param {object} [opts.env]
 * @returns {Array<{host:string, hits:number, maxEngineCount:number, bestRank:number, score:number, sample:string}>}
 */
function discoverEmergingSources(results, opts = {}) {
  if (!isEnabled(opts.env)) return [];
  if (!Array.isArray(results) || results.length === 0) return [];
  const known = opts.knownHosts instanceof Set ? opts.knownHosts : KNOWN_HOSTS;
  const cap = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : 5;

  const byHost = new Map();
  results.forEach((r, idx) => {
    const host = _host(r && (r.url || r.link));
    if (!host || _isKnownHost(host, known)) return;
    let rec = byHost.get(host);
    if (!rec) { rec = { host, hits: 0, maxEngineCount: 0, bestRank: idx, sample: '' }; byHost.set(host, rec); }
    rec.hits += 1;
    rec.bestRank = Math.min(rec.bestRank, idx);
    const ec = Number.isFinite(r.engineCount) ? r.engineCount : 1;
    if (ec > rec.maxEngineCount) rec.maxEngineCount = ec;
    if (!rec.sample && r && r.title) rec.sample = String(r.title).replace(/\s+/g, ' ').trim().slice(0, 80);
  });

  const emerging = [...byHost.values()]
    .map((rec) => ({ ...rec, score: _scoreSource(rec, results.length) }))
    // 只留「真的冒头」的:被≥2引擎收录,或出现≥2次,或排进前 3 名。
    .filter((s) => s.maxEngineCount >= 2 || s.hits >= 2 || s.bestRank < 3);

  emerging.sort((a, b) => (b.score - a.score) || (a.bestRank - b.bestRank) || a.host.localeCompare(b.host));
  return emerging.slice(0, cap);
}

/**
 * 据新发现的源产出 `site:host query` 跟进检索串,让 khy 能在新站点上深入。
 * @param {Array} emerging  discoverEmergingSources 的返回
 * @param {string} query
 * @param {number} [max]
 * @returns {string[]}
 */
function suggestSiteQueries(emerging, query, max = 3) {
  const q = String(query || '').trim();
  if (!q || !Array.isArray(emerging)) return [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 3;
  return emerging.slice(0, cap).map((s) => `site:${s.host} ${q}`);
}

/**
 * 把发现的新源格式化成一段附在搜索结果末尾的「新发现来源」页脚。空 → ''。
 * @param {Array} emerging
 * @returns {string}
 */
function formatDiscoveryFooter(emerging) {
  if (!Array.isArray(emerging) || emerging.length === 0) return '';
  const lines = emerging.map((s) => {
    const note = s.maxEngineCount >= 2 ? `${s.maxEngineCount} 个引擎收录` : `出现 ${s.hits} 次`;
    return `  • ${s.host}（${note}）`;
  });
  return '\n\n---\n🆕 新发现来源（非内置搜索源，但在结果里反复出现，可用 WebSearch 加 `site:` 深入）：\n'
    + lines.join('\n');
}

module.exports = {
  isEnabled,
  KNOWN_PARSERS,
  KNOWN_HOSTS,
  loadDynamicEngines,
  buildEngineUrl,
  discoverEmergingSources,
  suggestSiteQueries,
  formatDiscoveryFooter,
  // 内部函数暴露给单测(无网络)。
  __internal: { normalizeEngine: _normalizeEngine, host: _host, isKnownHost: _isKnownHost, scoreSource: _scoreSource },
};
