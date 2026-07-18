'use strict';

/**
 * mojeekEngine.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 联网搜索的扇出(webSearchService.ENGINE_REGISTRY)当前是 5 个免 key 抓取引擎——百度 /
 * Bing 中国 / DuckDuckGo(需代理) / 搜狗 / 360——**全部偏国内**:DuckDuckGo 之外没有一个
 * 「无需代理、独立自建索引、面向全球」的引擎。于是非中文/国际类查询要么只拿到国内引擎的
 * 结果,要么全压在需要代理的 DuckDuckGo 上,代理不可用时国际召回直接塌成 0。
 *
 * 本叶子把 Mojeek(https://www.mojeek.com,独立自建爬虫索引、免 key、直连 HTML、无需代理)
 * 收口为单一真源:声明「引擎名 / 融合权重 / 结果页 URL / 结果卡片选择器 / 行归一化」。真正的
 * cheerio 解析与 http 抓取仍在 webSearchService 侧(与既有 _parseXxxHtml / searchXxx 同构),
 * 本叶子只提供**纯**的决策与形状,不 require cheerio、不发网络请求。
 *
 * 门控 KHY_SEARCH_MOJEEK(默认开):关(0/false/off/no)→ isMojeekEnabled 恒 false →
 * webSearchService._resolveFanout 完全不把 Mojeek 并入扇出 → 逐字节回退今日「仅 5 国内引擎」
 * 行为。绝不抛:异常一律回退关门语义。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const MOJEEK_ENGINE_NAME = 'mojeek';
// 融合权重(RRF):置于 duckduckgo(0.90)与 sogou(0.85)之间——作为独立全球引擎补充国际召回,
// 但不盖过国内直连最稳的百度/Bing。
const MOJEEK_WEIGHT = 0.88;

// 结果卡片选择器(供 webSearchService 侧 cheerio 解析消费)。多组回退容忍版式变体:
//   - 容器:results-standard 列表项 / 通用 result li。
//   - 标题锚:a.title / h2 a(Mojeek 的出站链接是直接绝对 URL,无跳转桩,无需还原)。
//   - 摘要:p.s / result-description / 兜底段落。
const MOJEEK_SELECTORS = Object.freeze({
  container: 'ul.results-standard > li, ol.results-standard > li, li.result, .results li',
  title: 'a.title, h2 a, a.ob',
  snippet: 'p.s, p.result-description, p.result-desc, p',
});

/**
 * 门控 KHY_SEARCH_MOJEEK:默认开;0/false/off/no → 关。异常回退关门(false)。
 * flagRegistry 优先,失败回退本地 CANON 解析。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isMojeekEnabled(env = process.env) {
  try {
    const e = env || {};
    // flagRegistry 优先(登记为 default-on);不可用则回退本地 CANON 解析。
    try {
      const reg = require('../flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_SEARCH_MOJEEK', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_SEARCH_MOJEEK;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * Mojeek 结果页 URL(免 key,直连)。空 query → ''。
 * @param {string} query
 * @returns {string}
 */
function buildMojeekUrl(query) {
  try {
    const q = String(query == null ? '' : query).trim().slice(0, 200);
    if (!q) return '';
    return `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`;
  } catch {
    return '';
  }
}

/**
 * 纯行归一化:把抓到的 {title,url,snippet} 折叠空白并校验。缺 title/url → null。
 * 只接受绝对 http(s) URL(Mojeek 出站链接均为绝对地址),过滤内部导航锚。
 * @param {{title?:string, url?:string, snippet?:string}} row
 * @returns {{title:string, url:string, snippet:string}|null}
 */
function normalizeMojeekRow(row) {
  try {
    const r = row || {};
    const title = String(r.title == null ? '' : r.title).replace(/\s+/g, ' ').trim();
    const url = String(r.url == null ? '' : r.url).trim();
    if (!title || !url) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    const snippet = String(r.snippet == null ? '' : r.snippet).replace(/\s+/g, ' ').trim();
    return { title, url, snippet };
  } catch {
    return null;
  }
}

module.exports = {
  MOJEEK_ENGINE_NAME,
  MOJEEK_WEIGHT,
  MOJEEK_SELECTORS,
  isMojeekEnabled,
  buildMojeekUrl,
  normalizeMojeekRow,
};
