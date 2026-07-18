/**
 * Web Search Service — search the web using Kiro's InvokeMCP API.
 *
 * Reuses kiroAdapter's auth token and SDK client infrastructure.
 * Calls Amazon Q Developer's InvokeMCP endpoint with the web_search tool.
 *
 * Reference: https://github.com/Colin3191/kiro-web-search
 */
const crypto = require('crypto');
// Safe to require eagerly: playwrightSearch lazy-loads the (optional) browser
// only when a fetch is actually attempted, so this never throws if playwright
// is absent.
const playwrightSearch = require('./playwrightSearch');

// ── 时间维度 / 新鲜度(goal 2026-06-25「怎么搜才能拿到最新数据」)──────────
// 单一真源 searchFreshness 纯叶子,fail-soft require:缺失则全程降级为「不限时」,
// 搜索路径照常工作。把窗口拼进各引擎结果页 URL(按时间过滤),并对结果按日期重排
// (兜底「按日期排序」,与引擎是否真认 URL 参数无关)。
let _freshness = null;
try { _freshness = require('./search/searchFreshness'); } catch { /* optional */ }

/** 决定本次搜索的时间窗口:显式 opts.freshness 优先,否则按 query 自动识别。 */
function _resolveFreshWindow(query, opts) {
  if (!_freshness) return null;
  try { return _freshness.resolveWindow((opts || {}).freshness, query, process.env); }
  catch { return null; }
}

/** 返回拼到引擎 URL 的 query 片段(不含前导 &),无则 ''。 */
function _freshParam(window, engine) {
  if (!_freshness || !window) return '';
  try { return _freshness.freshnessToEngineParam(window, engine, Date.now()) || ''; }
  catch { return ''; }
}

/** 把时间过滤片段安全拼到一个已带 query 串的 URL 上。 */
function _withFreshParam(url, window, engine) {
  const fp = _freshParam(window, engine);
  return fp ? `${url}&${fp}` : url;
}

/** 结果按日期富化 + 窗口内重排(绝不丢结果)。窗口空时仅回填 publishedDate。 */
function _applyRecency(results, window) {
  if (!_freshness || !Array.isArray(results)) return results;
  try { return _freshness.applyRecencyRanking(results, window, Date.now(), process.env); }
  catch { return results; }
}

// ── 源发现(goal 2026-06-26「固定站点之外,新站点 khy 怎么发现」)─────────────
// 单一真源 searchSourceDiscovery 纯叶子,fail-soft require:缺失则降级为「只有内置 5 引擎、
// 不挖新源」,搜索路径照常工作。两件事:(1) loadDynamicEngines 让运行期声明的额外引擎并入
// 扇出(无需改源码);(2) discoverEmergingSources 从结果里挖出反复出现的新冒头权威源。
let _discovery = null;
try { _discovery = require('./search/searchSourceDiscovery'); } catch { /* optional */ }

/** 读取数据家下的 search_engines.json(声明额外引擎)。fail-soft,缺失/出错 → ''。 */
function _readEngineConfigText() {
  try {
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const { getAppDataDir } = require('../utils/dataHome');
    const p = getAppDataDir('search_engines.json');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch { /* ignore — 数据家不可用 / 文件缺失,降级为仅 env 声明 */ }
  return '';
}

// 内置引擎自身的域名,并入「已知源」集合,避免把内置引擎结果误判成「新发现来源」。
function _knownHostSet() {
  const base = (_discovery && _discovery.KNOWN_HOSTS instanceof Set) ? _discovery.KNOWN_HOSTS : null;
  if (!base) return undefined;
  return base; // searchSourceDiscovery.KNOWN_HOSTS 已含内置引擎域名 + 大众门户
}

/**
 * 把一个动态引擎声明编织成与内置引擎同形的抓取函数 (query, freshWindow) => {success,results}。
 * 复用内置的 http 抓取 / 解析原语:按声明的 parser 选解析器(generic 兜底任意新站点),
 * URL 走 buildEngineUrl 模板填充 + 时间过滤片段。
 */
function _makeDynamicEngine(descriptor) {
  const PARSERS = {
    baidu: _parseBaiduHtml,
    bing: _parseBingHtml,
    duckduckgo: _parseDuckDuckGoHtml,
    sogou: _parseSogouHtml,
    so360: _parseSo360Html,
    generic: _parseGenericHtml,
  };
  const parse = PARSERS[descriptor.parser] || _parseGenericHtml;
  const label = `dyn:${descriptor.engine || descriptor.name}`;
  return async function dynamicEngine(query, freshWindow = null) {
    const trimmed = String(query || '').trim();
    if (!trimmed) return { success: false, error: 'Search query is empty' };
    // 时间过滤:声明若指定了已知 parser 家族就借用其引擎参数,否则用 duckduckgo 的 df= 作通用近似。
    const freshEngine = descriptor.parser === 'generic' ? 'duckduckgo' : descriptor.parser;
    const freshParam = _freshParam(freshWindow, freshEngine === 'bing' ? 'bing-cn' : freshEngine);
    const url = _discovery ? _discovery.buildEngineUrl(descriptor, trimmed, freshParam) : '';
    if (!url) return { success: false, error: `${label}: empty URL` };
    return new Promise((resolve) => {
      const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      };
      let req;
      try {
        req = _httpClientFor(url).get(url, { headers, timeout: 10000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const rUrl = /^https?:\/\//.test(res.headers.location)
              ? res.headers.location
              : new URL(res.headers.location, url).toString();
            const rReq = _httpClientFor(rUrl).get(rUrl, { headers, timeout: 10000 },
              (rRes) => _collectAndParse(rRes, MAX_RESPONSE_BYTES, parse, label, resolve));
            rReq.on('error', (e) => resolve({ success: false, error: `${label} redirect failed: ${e.message}` }));
            rReq.on('timeout', () => { rReq.destroy(); resolve({ success: false, error: `${label} timed out` }); });
            return;
          }
          _collectAndParse(res, MAX_RESPONSE_BYTES, parse, label, resolve);
        });
      } catch (err) { resolve({ success: false, error: `${label} request error: ${err.message}` }); return; }
      req.on('error', (err) => resolve({ success: false, error: `${label} search failed: ${err.message}` }));
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: `${label} search timed out` }); });
    });
  };
}

/** 装载运行期声明的额外引擎(env + 数据家配置),编织成扇出项。缺失/出错 → []。 */
function _loadDynamicFanout() {
  if (!_discovery) return [];
  try {
    const descriptors = _discovery.loadDynamicEngines({ env: process.env, configText: _readEngineConfigText() });
    return descriptors.map((d) => ({ engine: d.name, fn: _makeDynamicEngine(d), weight: d.weight }));
  } catch { return []; }
}

/**
 * 给一个成功的搜索结果附上「新发现来源」:从结果里挖出反复出现却非内置源的权威站点,
 * 附 discoveredSources / suggestedSiteQueries 字段,并把发现页脚追加到 formatted 文本
 * (让模型能看到并用 site: 深入)。fail-soft:无发现 / 出错 → 原样返回。
 */
function _withDiscovery(payload, query) {
  try {
    if (!_discovery || !payload || !payload.success || !Array.isArray(payload.results)) return payload;
    const emerging = _discovery.discoverEmergingSources(payload.results, { knownHosts: _knownHostSet(), env: process.env });
    if (!emerging || emerging.length === 0) return payload;
    return {
      ...payload,
      discoveredSources: emerging,
      suggestedSiteQueries: _discovery.suggestSiteQueries(emerging, query),
      formatted: (payload.formatted || '') + _discovery.formatDiscoveryFooter(emerging),
    };
  } catch { return payload; }
}

// ── cheerio lazy loader ─────────────────────────────────────────────
// cheerio is declared in package.json dependencies, but on some installs
// (notably Windows where only the backend sub-package is `npm install`-ed and
// the dependency lands in the repo-root node_modules) require('cheerio') at
// module top level would throw and take the ENTIRE search subsystem down at
// load time. Mirror playwrightSearch._loadPlaywright: lazy, cached, and never
// throwing. Tri-state: null = not tried, false = absent, module = loaded.
let _cheerio = null;
function _loadCheerio() {
  if (_cheerio && _cheerio.load) return _cheerio; // 已加载
  try {
    // eslint-disable-next-line global-require
    const m = require('cheerio');
    const mod = (m && m.load) ? m : (m && m.default && m.default.load ? m.default : null);
    if (mod && mod.load) { _cheerio = mod; return mod; }
  } catch { /* not installed — degrade gracefully */ }
  // 缺失态不永久锁定：下次再尝试 require，使「会话中途自愈安装 cheerio」后的
  // 重试能立即拿到模块（否则 _cheerio 一旦为 false，装了也读不到 → 自愈白做功）。
  _cheerio = false;
  return null;
}

/** True when cheerio is available for HTML result parsing. */
function isHtmlParsingAvailable() {
  return _loadCheerio() !== null;
}

const SEARCH_TIMEOUT_MS = 30_000;
// 结果数不再写死 8 条，而是按需索取（goal 2026-06-25）。
//  - DEFAULT_RESULTS：调用方未指定 count 时的默认条数（可经 KHY_SEARCH_RESULTS 调）。
//  - RESULTS_CEILING：单次请求的硬上限，挡住失控的超大抓取；同时也是各引擎解析器
//    的候选召回上限——召回放宽到 ceiling（而非默认 8）能让权威/最新结果不被过早截断，
//    最终再按调用方请求的 limit 切片。这样「按需多取」与「召回充分」两件事解耦。
const DEFAULT_RESULTS = 8;
const RESULTS_CEILING = 30;
// 兼容旧引用：MAX_RESULTS 现等于召回上限（解析器/合并阶段的候选上界）。
const MAX_RESULTS = RESULTS_CEILING;

/**
 * 解析单次搜索请求要返回多少条结果。优先级：显式 count/limit > 环境默认
 * (KHY_SEARCH_RESULTS) > DEFAULT_RESULTS；统一夹到 [1, RESULTS_CEILING]。
 * @param {{limit?:number, count?:number, num?:number, topN?:number}} [opts]
 * @returns {number}
 */
function _resolveLimit(opts = {}) {
  const envDefault = parseInt(process.env.KHY_SEARCH_RESULTS, 10);
  const baseDefault = Number.isFinite(envDefault) && envDefault > 0
    ? Math.min(envDefault, RESULTS_CEILING)
    : DEFAULT_RESULTS;
  const raw = opts.limit ?? opts.count ?? opts.num ?? opts.topN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return baseDefault;
  return Math.max(1, Math.min(n, RESULTS_CEILING));
}

// ── protocol-aware transport selection ──────────────────────────────
// A 3xx redirect's Location can downgrade https → http (e.g. a search engine
// bouncing through an http:// interstitial). Calling https.get() on an http://
// URL throws `ERR_INVALID_PROTOCOL: Protocol "http:" not supported. Expected
// "https:"`, which previously took the whole search attempt down. Pick the
// transport module from the URL's actual scheme instead of hardcoding https.
// Defaults to https for scheme-relative or unparseable inputs (the conservative
// choice for the primary GETs, which are always https literals).
function _httpClientFor(url) {
  let scheme = 'https:';
  try {
    scheme = new URL(String(url)).protocol;
  } catch {
    if (/^http:\/\//i.test(String(url))) scheme = 'http:';
  }
  // eslint-disable-next-line global-require
  return scheme === 'http:' ? require('http') : require('https');
}

// Reciprocal Rank Fusion constant. A higher K flattens the contribution of
// rank position (so consensus across engines matters more than being #1 in any
// single engine); the classic metasearch default is 60. Overridable so ops can
// tune fusion behavior without a code change (零硬编码 工程规则).
function _rrfK() {
  const v = Number(process.env.KHY_SEARCH_RRF_K);
  return Number.isFinite(v) && v > 0 ? v : 60;
}

// ── Domain type classification ──────────────────────────────────────
const _DOMAIN_TYPE_MAP = {
  'stackoverflow.com': 'forum', 'stackexchange.com': 'forum', 'reddit.com': 'forum',
  'github.com': 'code', 'gitlab.com': 'code', 'gitee.com': 'code',
  'developer.mozilla.org': 'docs', 'docs.python.org': 'docs', 'nodejs.org': 'docs',
  'wikipedia.org': 'reference', 'baike.baidu.com': 'reference',
  'medium.com': 'blog', 'dev.to': 'blog', 'csdn.net': 'blog', 'juejin.cn': 'blog',
  'zhihu.com': 'forum', 'segmentfault.com': 'forum',
  'news.ycombinator.com': 'news', 'bbc.com': 'news', 'reuters.com': 'news',
};

function _classifyDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    for (const [domain, type] of Object.entries(_DOMAIN_TYPE_MAP)) {
      if (hostname.includes(domain)) return type;
    }
  } catch {}
  return 'other';
}

function _extractDomain(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ── cheerio-based result parsers ────────────────────────────────────
// Structured selectors replace the old hand-rolled regex extraction, which
// shattered every time an engine tweaked its result-page markup. Each parser
// returns a normalized result[] (title/url/snippet/domain/type), capped at
// MAX_RESULTS. Multiple selector fallbacks tolerate layout variants.

function _mkResult(title, url, snippet) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  const u = String(url || '').trim();
  if (!t || !u) return null;
  return {
    title: t,
    url: u,
    snippet: String(snippet || '').replace(/\s+/g, ' ').trim(),
    publishedDate: '',
    domain: _extractDomain(u),
    type: _classifyDomain(u),
  };
}

// DuckDuckGo wraps outbound links as //duckduckgo.com/l/?uddg=<encoded>&...
function _decodeDdgHref(href) {
  if (!href) return '';
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function _parseDuckDuckGoHtml(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  const $ = cheerio.load(html);
  const out = [];
  $('div.result, div.web-result, .results_links').each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const node = $(el);
    const a = node.find('a.result__a').first();
    const title = a.text();
    const url = _decodeDdgHref(a.attr('href'));
    const snippet = node.find('.result__snippet').first().text();
    const r = _mkResult(title, url, snippet);
    if (r) out.push(r);
  });
  return out;
}

// Snippet text that is too short to be a real abstract — usually a stray label
// ("百度快照", a date, a source name). Below this we treat the snippet as empty
// and fall back to the container-shape extraction.
const _MIN_SNIPPET_LEN = 10;

// 百度结果链接是 https://www.baidu.com/link?url=<token> 的 302 跳转桩。WebFetch 能跟随
// 拿到真实页，但模型判读 / dedup / 分类都需要真实站点，否则模型只看到不透明跳转桩，
// 往往为每条结果再多抓一次 WebFetch —— 那些多余抓取反向喂大了搜索循环
// (见 searchConvergence.RULES.S3_baidu_real_url)。还原优先级镜像 _sogouRealUrl：
//   ① 模板卡常把真实 URL 暴露在容器/链接的 mu / data-mu / data-url 属性 → 直接采用；
//   ② 退读可见的绿色来源 / cite 文本(.c-showurl / .cosc-source-text /
//      [class*="source"] / .c-color-gray)，裸 host 补成 https://host；
//   ③ 都拿不到才回落原始 /link? 包装 href(WebFetch 仍可跟随重定向，保今天行为)。
function _baiduRealUrl(node, a, wrappedHref) {
  const attrUrl = String(
    (a && (a.attr('data-url') || a.attr('mu') || a.attr('data-mu')))
    || (node && (node.attr('mu') || node.attr('data-mu') || node.attr('data-url')))
    || ''
  ).trim();
  if (/^https?:\/\//i.test(attrUrl)) return attrUrl;
  const cite = node
    ? String(node.find('.c-showurl, .cosc-source-text, [class*="source"], .c-color-gray').first().text() || '')
        .replace(/\s+/g, '').trim()
    : '';
  if (cite) {
    if (/^https?:\/\//i.test(cite)) return cite;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(cite)) return `https://${cite}`;
  }
  return String(wrappedHref || '').trim();
}

function _parseBaiduHtml(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  const $ = cheerio.load(html);
  const out = [];
  // `div[tpl]` catches Baidu's newer template-driven result cards whose only
  // stable marker is the `tpl="..."` attribute (the .result/.c-container class
  // pair is increasingly dropped on A/B layouts).
  const containers = $('#content_left .result, #content_left .c-container, .result.c-container, #content_left div[tpl]');
  containers.each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const node = $(el);
    const a = node.find('h3 a, .t a, h3.c-title a').first();
    const title = a.text();
    const url = _baiduRealUrl(node, a, a.attr('href'));
    // Broadened selector set covers Baidu's rotating abstract class names
    // (content-right_*, content_right_*, c-line-clamp{2,3}, c-gap-* spans).
    let snippet = node.find(
      '.c-abstract, [class*="content-right"], [class*="content_right"], '
      + '.c-span-last .c-color-text, .c-line-clamp2, .c-line-clamp3, '
      + '.c-color-text, .c-font-normal'
    ).first().text();
    snippet = String(snippet || '').replace(/\s+/g, ' ').trim();
    // Shape-based fallback: when every class selector misses (Baidu renames them
    // often), derive the snippet from the container's own text minus the title.
    // This depends on DOM structure, not class names, so it survives reskins —
    // the root cause behind "title only, no body" results.
    if (snippet.length < _MIN_SNIPPET_LEN) {
      const full = node.text().replace(/\s+/g, ' ').trim();
      const t = String(title || '').replace(/\s+/g, ' ').trim();
      const rest = (t && full.startsWith(t)) ? full.slice(t.length) : full;
      snippet = rest.trim().slice(0, 300);
    }
    const r = _mkResult(title, url, snippet);
    if (r) out.push(r);
  });
  // Fallback: bare h3 > a if container selectors miss (Baidu A/B layouts).
  if (out.length === 0) {
    $('h3 a, h3.t a').each((_, el) => {
      if (out.length >= MAX_RESULTS) return false;
      const a = $(el);
      const href = String(a.attr('href') || '');
      // Drop home-page chrome served on a bot-challenge: real Baidu result
      // links are absolute http(s) (typically www.baidu.com/link?url=...).
      // Relative/anchor/javascript hrefs are navigation, not results.
      if (!/^https?:\/\//i.test(href)) return;
      const r = _mkResult(a.text(), href, '');
      if (r) out.push(r);
    });
  }
  return out;
}

function _parseBingHtml(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  const $ = cheerio.load(html);
  const out = [];
  $('#b_results li.b_algo, li.b_algo').each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const node = $(el);
    const a = node.find('h2 a').first();
    const title = a.text();
    const url = a.attr('href') || '';
    const snippet = node.find('.b_caption p, .b_algoSlug, p').first().text();
    const r = _mkResult(title, url, snippet);
    if (r) out.push(r);
  });
  return out;
}

// 搜狗结果链接是 https://www.sogou.com/link?url=<base64ish> 的 302 跳转。WebFetch
// 会跟随重定向拿到真实页，所以包装链接可直接用作 url；但 dedup/分类需要真实站点，
// 故优先采用结果卡片里可见的「绿色 cite 站点文本」(.fz-mid / .citeurl / cite) 推断
// 真实 host：若是裸 host 则补成 https://host/。拿不到才回退到 sogou 包装链接。
function _sogouRealUrl(citeText, wrappedHref) {
  const cite = String(citeText || '').replace(/\s+/g, '').trim();
  if (cite) {
    if (/^https?:\/\//i.test(cite)) return cite;
    // 形如 "www.example.com/path" 的可见站点文本 → 补协议
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(cite)) return `https://${cite}`;
  }
  const href = String(wrappedHref || '').trim();
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return `https://www.sogou.com${href}`;
  return '';
}

function _parseSogouHtml(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  const $ = cheerio.load(html);
  const out = [];
  // .vrwrap/.rb 是搜狗结果卡片的稳定标记；.results .result 容错旧/新版式。
  $('.results .vrwrap, .results .rb, .vrwrap, .rb').each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const node = $(el);
    const a = node.find('h3 a, .vr-title a, .vrTitle a').first();
    const title = a.text();
    if (!title) return;
    const cite = node.find('.fz-mid, .citeurl, cite, .str-pd-box cite').first().text();
    const url = _sogouRealUrl(cite, a.attr('href'));
    const snippet = node.find('.fz-mid ~ .str_info, .str-text-info, .text-layout, .str_info, .ft').first().text();
    const r = _mkResult(title, url, snippet);
    if (r) out.push(r);
  });
  return out;
}

function _parseSo360Html(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  const $ = cheerio.load(html);
  const out = [];
  // 360 把结果包在 li.res-list；真实目标 URL 暴露在 data-mdurl / data-url 属性，
  // 包装 href 仅作兜底（其 /link? 跳转 WebFetch 同样可跟随）。
  $('#main .res-list, li.res-list, .res-list').each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const node = $(el);
    const a = node.find('h3 a, .res-title a').first();
    const title = a.text();
    if (!title) return;
    const url = a.attr('data-mdurl') || a.attr('data-url') || a.attr('href') || '';
    const snippet = node.find('.res-desc, .res-rich, p').first().text();
    const r = _mkResult(title, url, snippet);
    if (r) out.push(r);
  });
  return out;
}

// Mojeek(独立自建索引、免 key、直连、无需代理)结果解析。选择器收口在 mojeekEngine 叶子,
// 出站链接是直接绝对 URL(无跳转桩),故无需 URL 还原。fail-soft:叶子/cheerio 缺失 → []。
function _parseMojeekHtml(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  let sel;
  try { sel = require('./search/mojeekEngine').MOJEEK_SELECTORS; }
  catch { return []; }
  let norm = null;
  try { norm = require('./search/mojeekEngine').normalizeMojeekRow; } catch { norm = null; }
  const $ = cheerio.load(html);
  const out = [];
  $(sel.container).each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const node = $(el);
    const a = node.find(sel.title).first();
    const title = a.text();
    const url = a.attr('href') || '';
    const snippet = node.find(sel.snippet).first().text();
    const row = norm ? norm({ title, url, snippet }) : null;
    const r = row ? _mkResult(row.title, row.url, row.snippet) : _mkResult(title, url, snippet);
    if (r) out.push(r);
  });
  return out;
}

/**
 * Generic best-effort parser for a **brand-new** search site declared at runtime
 * (searchSourceDiscovery dynamic engine, parser:'generic'). We don't know the
 * site's result-card markup, so harvest heuristically: anchors with an http(s)
 * href and non-trivial text become candidate results, with the nearest block
 * text as a snippet. Skips obvious nav/asset/anchor links and same-page hashes.
 * Conservative — returns [] rather than guessing when cheerio is unavailable.
 */
function _parseGenericHtml(html) {
  const cheerio = _loadCheerio();
  if (!cheerio) return [];
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  // Reduce noise: skip links inside header/nav/footer/aside chrome.
  $('header a, nav a, footer a, aside a').addClass('__khy_chrome');
  $('a[href]').each((_, el) => {
    if (out.length >= MAX_RESULTS) return false;
    const a = $(el);
    if (a.hasClass('__khy_chrome')) return;
    const href = String(a.attr('href') || '').trim();
    if (!/^https?:\/\//i.test(href)) return;        // 只要绝对 http(s) 外链
    const title = a.text().replace(/\s+/g, ' ').trim();
    if (title.length < 8) return;                   // 太短多半是图标/导航
    const key = _dedupKey(href);
    if (seen.has(key)) return;
    seen.add(key);
    // 摘要:取链接所在卡片(就近祖先)的文本,扣掉标题本身。
    const card = a.closest('li, article, .result, .item, div');
    let snippet = card && card.length ? card.text().replace(/\s+/g, ' ').trim() : '';
    if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
    const r = _mkResult(title, href, snippet.slice(0, 200));
    if (r) out.push(r);
  });
  return out;
}

// Lazy refs
let _kiroAdapter = null;

function getKiroAdapter() {
  if (!_kiroAdapter) {
    _kiroAdapter = require('./gateway/adapters/kiroAdapter');
  }
  return _kiroAdapter;
}

function isQueueEmptyLikeError(message = '') {
  const text = String(message || '').toLowerCase();
  return /queue[\s_-]*is[\s_-]*empty/.test(text)
    || /empty[\s_-]*queue/.test(text)
    || /队列.*为空/.test(text)
    || /队列为空/.test(text);
}

/**
 * Check if web search is available (Kiro token exists).
 * @returns {boolean}
 */
function isAvailable() {
  try {
    return getKiroAdapter().detect();
  } catch {
    return false;
  }
}

/**
 * Search the web using Kiro's remote MCP web_search tool.
 *
 * @param {string} query - Search query (max 200 characters)
 * @returns {Promise<{success: boolean, results?: object[], formatted?: string, error?: string}>}
 */
async function search(query, opts = {}) {
  if (!query || typeof query !== 'string') {
    return { success: false, error: 'Search query is required' };
  }

  // Enforce max length per API spec
  const trimmedQuery = query.trim().slice(0, 200);
  if (!trimmedQuery) {
    return { success: false, error: 'Search query is empty' };
  }

  const retryOnQueueEmpty = opts.retryOnQueueEmpty !== false;
  const limit = _resolveLimit(opts);

  // 新鲜度:Kiro/MCP 用博查式枚举(oneDay/oneWeek/oneMonth/oneYear)。归一化 opts.freshness
  // (可能是已解析的内部窗口名,也可能是原始外部值),映射成 MCP arguments.freshness。
  let _bochaFreshness = null;
  if (_freshness && opts.freshness) {
    try {
      const w = _freshness.normalizeWindow(opts.freshness);
      if (w && w !== 'auto') _bochaFreshness = _freshness.windowToBochaFreshness(w);
    } catch { /* optional */ }
  }

  try {
    const kiro = getKiroAdapter();
    const tokenData = await kiro.getAccessToken();
    const client = await kiro.createSDKClient(tokenData);
    const { InvokeMCPCommand, MCPMethod } = await kiro.getCWModule();

    const command = new InvokeMCPCommand({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: MCPMethod.TOOLS_CALL,
      profileArn: tokenData.profileArn,
      params: {
        name: 'web_search',
        arguments: _bochaFreshness
          ? { query: trimmedQuery, freshness: _bochaFreshness }
          : { query: trimmedQuery },
      },
    });

    // Race against timeout
    const response = await Promise.race([
      client.send(command),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Web search timed out (30s)')), SEARCH_TIMEOUT_MS)
      ),
    ]);

    if (response.error) {
      const queueLike = isQueueEmptyLikeError(response.error.message);
      if (queueLike && retryOnQueueEmpty) {
        try { getKiroAdapter().destroy(); } catch { /* ignore */ }
        return search(trimmedQuery, { ...opts, retryOnQueueEmpty: false });
      }
      return {
        success: false,
        error: `Web search failed (code ${response.error.code}): ${response.error.message}`,
      };
    }

    // Parse and format results
    const { results, formatted } = formatResults(response.result, limit);
    return { success: true, results, formatted };
  } catch (err) {
    const queueLike = isQueueEmptyLikeError(err?.message);
    if (queueLike && retryOnQueueEmpty) {
      try { getKiroAdapter().destroy(); } catch { /* ignore */ }
      return search(trimmedQuery, { ...opts, retryOnQueueEmpty: false });
    }
    // Clear cached client on auth errors
    if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('expired')) {
      try { getKiroAdapter().destroy(); } catch { /* ignore */ }
    }
    return { success: false, error: err.message || 'Web search failed' };
  }
}

/**
 * Strip system/instruction tags that may leak from upstream providers (e.g. Kiro MCP).
 * These tags confuse downstream LLMs into thinking it's a prompt injection.
 */
function _sanitizeProviderText(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/<system_context>[\s\S]*?<\/system_context>/gi, '')
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/gi, '')
    .replace(/<system[_-]?prompt>[\s\S]*?<\/system[_-]?prompt>/gi, '')
    .replace(/<instructions>[\s\S]*?<\/instructions>/gi, '')
    .trim();
}

/**
 * Parse MCP response into structured results + formatted markdown.
 */
function formatResults(result, limit = DEFAULT_RESULTS) {
  const empty = { results: [], formatted: 'No results found.' };
  if (!result?.content) return empty;

  const textContent = result.content.find(c => c.type === 'text');
  if (!textContent?.text) return empty;

  // Sanitize provider leakage before parsing
  const cleanText = _sanitizeProviderText(textContent.text);
  if (!cleanText) return empty;

  try {
    const parsed = JSON.parse(cleanText);
    if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
      return { results: [], formatted: _sanitizeProviderText(cleanText) };
    }

    const results = parsed.results.slice(0, limit).map(r => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      snippet: r.snippet || '',
      publishedDate: r.publishedDate || '',
      domain: _extractDomain(r.url || ''),
      type: _classifyDomain(r.url || ''),
    }));

    const formatted = _formatResultsMarkdown(results);
    return { results, formatted };
  } catch {
    return { results: [], formatted: _sanitizeProviderText(cleanText) };
  }
}

/**
 * Format results array into enhanced markdown with domain tags and chaining footer.
 */
function _formatResultsMarkdown(results) {
  if (!results || results.length === 0) return 'No results found.';

  const TYPE_LABELS = {
    forum: 'Forum', code: 'Code', docs: 'Docs', reference: 'Reference',
    blog: 'Blog', news: 'News', other: '',
  };

  const lines = results.map((r, i) => {
    const tag = TYPE_LABELS[r.type] || '';
    // Consensus annotation: a result surfaced by ≥2 independent engines is a
    // stronger signal — make that visible so accuracy is explainable.
    const consensus = r.engineCount >= 2 ? ` [${r.engineCount} 来源]` : '';
    const tagPart = tag ? ` [${tag}]` : '';
    const header = `### ${i + 1}. ${r.title}${tagPart}${consensus}`;
    const parts = [header];
    if (r.url) parts.push(`URL: ${r.url}`);
    if (r.snippet) parts.push(r.snippet);
    if (r.publishedDate) parts.push(`Published: ${r.publishedDate}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');

  return lines + '\n\n---\nTo read the full content of any result, use WebFetch with the URL above.';
}

/**
 * Fallback search via DuckDuckGo HTML (no API key needed).
 * Used when Kiro token is unavailable.
 */
async function searchFallback(query, freshWindow = null) {
  const https = require('https');
  const trimmedQuery = String(query || '').trim().slice(0, 200);
  if (!trimmedQuery) return { success: false, error: 'Search query is empty' };

  // 获取代理配置（国外站点需要走代理）
  let proxyUrl = null;
  try {
    const proxyConfig = require('./proxyConfigService');
    const proxy = proxyConfig.getActiveProxy();
    if (proxy && proxy.url) proxyUrl = proxy.url;
  } catch { /* ignore */ }
  // 环境变量兜底
  if (!proxyUrl) proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;

  return new Promise((resolve) => {
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB cap
    const url = _withFreshParam(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmedQuery)}&kl=cn-zh`, freshWindow, 'duckduckgo');

    if (proxyUrl) {
      // 通过 HTTP CONNECT 隧道代理
      return _searchViaProxy(url, proxyUrl, MAX_RESPONSE_BYTES, resolve);
    }
    const req = https.get(url, {
      headers: { 'User-Agent': 'KHY-OS/1.0 (search fallback)' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          return;
        }
        data += chunk;
      });
      res.on('end', () => {
        try {
          const results = _parseDuckDuckGoHtml(data);
          if (results.length === 0) {
            resolve({ success: true, results: [], formatted: 'No results found.' });
            return;
          }
          resolve({ success: true, results, formatted: _formatResultsMarkdown(results) });
        } catch (err) {
          resolve({ success: false, error: `Search parse error: ${err.message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: `Search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Search timed out' }); });
  });
}

/**
 * 国内搜索：百度（最可靠的国内直连搜索引擎）
 */
async function searchBaidu(query, freshWindow = null) {
  const https = require('https');
  const trimmedQuery = String(query || '').trim().slice(0, 200);
  if (!trimmedQuery) return { success: false, error: 'Search query is empty' };

  return new Promise((resolve) => {
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    const url = _withFreshParam(`https://www.baidu.com/s?wd=${encodeURIComponent(trimmedQuery)}&rn=20&ie=utf-8`, freshWindow, 'baidu');
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cookie': 'BAIDUID=0:FG=1',
      },
      timeout: 10000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const rUrl = res.headers.location.startsWith('http') ? res.headers.location : `https://www.baidu.com${res.headers.location}`;
        const rReq = _httpClientFor(rUrl).get(rUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 10000,
        }, (rRes) => _parseBaiduResponse(rRes, MAX_RESPONSE_BYTES, resolve));
        rReq.on('error', (e) => resolve({ success: false, error: `Baidu redirect failed: ${e.message}` }));
        rReq.on('timeout', () => { rReq.destroy(); resolve({ success: false, error: 'Baidu timed out' }); });
        return;
      }
      _parseBaiduResponse(res, MAX_RESPONSE_BYTES, resolve);
    });
    req.on('error', (err) => resolve({ success: false, error: `Baidu search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Baidu search timed out' }); });
  });
}

function _parseBaiduResponse(res, maxBytes, resolve) {
  let data = '';
  let bytes = 0;
  res.setEncoding('utf8');
  res.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) { res.destroy(); return; }
    data += chunk;
  });
  res.on('end', () => {
    try {
      const results = _parseBaiduHtml(data);
      if (results.length === 0) {
        resolve({ success: false, error: 'Baidu: no results parsed from response' });
        return;
      }
      resolve({ success: true, results, formatted: _formatResultsMarkdown(results) });
    } catch (err) {
      resolve({ success: false, error: `Baidu parse error: ${err.message}` });
    }
  });
}

/**
 * 国内搜索：通过 Bing 中国站（cn.bing.com），无需代理。
 */
async function searchDomestic(query, freshWindow = null) {
  const https = require('https');
  const trimmedQuery = String(query || '').trim().slice(0, 200);
  if (!trimmedQuery) return { success: false, error: 'Search query is empty' };

  return new Promise((resolve) => {
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    const url = _withFreshParam(`https://cn.bing.com/search?q=${encodeURIComponent(trimmedQuery)}&setlang=zh-Hans&mkt=zh-CN`, freshWindow, 'bing-cn');
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: 10000,
    }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        const redirectReq = _httpClientFor(redirectUrl).get(redirectUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 10000,
        }, (redirectRes) => _parseBingResponse(redirectRes, MAX_RESPONSE_BYTES, resolve));
        redirectReq.on('error', () => resolve({ success: false, error: 'Bing redirect failed' }));
        redirectReq.on('timeout', () => { redirectReq.destroy(); resolve({ success: false, error: 'Bing timed out' }); });
        return;
      }
      _parseBingResponse(res, MAX_RESPONSE_BYTES, resolve);
    });
    req.on('error', (err) => resolve({ success: false, error: `Bing search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Bing search timed out' }); });
  });
}

function _parseBingResponse(res, maxBytes, resolve) {
  let data = '';
  let bytes = 0;
  res.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { res.destroy(); return; }
    data += chunk;
  });
  res.on('end', () => {
    try {
      const results = _parseBingHtml(data);
      if (results.length === 0) {
        resolve({ success: false, error: 'No results from Bing' });
        return;
      }
      resolve({ success: true, results, formatted: _formatResultsMarkdown(results) });
    } catch (err) {
      resolve({ success: false, error: `Bing parse error: ${err.message}` });
    }
  });
}

/**
 * Generic response collector for a domestic-direct engine: caps bytes, follows
 * one redirect hop, parses with the engine's cheerio parser, resolves a uniform
 * { success, results, formatted } / { success:false, error } shape.
 */
function _collectAndParse(res, maxBytes, parseHtml, label, resolve) {
  let data = '';
  let bytes = 0;
  res.setEncoding('utf8');
  res.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) { res.destroy(); return; }
    data += chunk;
  });
  res.on('end', () => {
    try {
      const results = parseHtml(data);
      if (!results || results.length === 0) {
        resolve({ success: false, error: `${label}: no results parsed from response` });
        return;
      }
      resolve({ success: true, results, formatted: _formatResultsMarkdown(results) });
    } catch (err) {
      resolve({ success: false, error: `${label} parse error: ${err.message}` });
    }
  });
}

/**
 * 国内搜索：搜狗（www.sogou.com），免 key 直连，拓宽召回。
 */
async function searchSogou(query, freshWindow = null) {
  const https = require('https');
  const trimmedQuery = String(query || '').trim().slice(0, 200);
  if (!trimmedQuery) return { success: false, error: 'Search query is empty' };

  return new Promise((resolve) => {
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    const url = _withFreshParam(`https://www.sogou.com/web?query=${encodeURIComponent(trimmedQuery)}&num=20`, freshWindow, 'sogou');
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    const req = https.get(url, { headers, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const rUrl = res.headers.location.startsWith('http') ? res.headers.location : `https://www.sogou.com${res.headers.location}`;
        const rReq = _httpClientFor(rUrl).get(rUrl, { headers, timeout: 10000 }, (rRes) => _collectAndParse(rRes, MAX_RESPONSE_BYTES, _parseSogouHtml, 'Sogou', resolve));
        rReq.on('error', (e) => resolve({ success: false, error: `Sogou redirect failed: ${e.message}` }));
        rReq.on('timeout', () => { rReq.destroy(); resolve({ success: false, error: 'Sogou timed out' }); });
        return;
      }
      _collectAndParse(res, MAX_RESPONSE_BYTES, _parseSogouHtml, 'Sogou', resolve);
    });
    req.on('error', (err) => resolve({ success: false, error: `Sogou search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Sogou search timed out' }); });
  });
}

/**
 * 国内搜索：360 搜索（www.so.com），免 key 直连，拓宽召回。
 */
async function searchSo360(query, freshWindow = null) {
  const https = require('https');
  const trimmedQuery = String(query || '').trim().slice(0, 200);
  if (!trimmedQuery) return { success: false, error: 'Search query is empty' };

  return new Promise((resolve) => {
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    const url = `https://www.so.com/s?q=${encodeURIComponent(trimmedQuery)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    const req = https.get(url, { headers, timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const rUrl = res.headers.location.startsWith('http') ? res.headers.location : `https://www.so.com${res.headers.location}`;
        const rReq = _httpClientFor(rUrl).get(rUrl, { headers, timeout: 10000 }, (rRes) => _collectAndParse(rRes, MAX_RESPONSE_BYTES, _parseSo360Html, 'So360', resolve));
        rReq.on('error', (e) => resolve({ success: false, error: `So360 redirect failed: ${e.message}` }));
        rReq.on('timeout', () => { rReq.destroy(); resolve({ success: false, error: 'So360 timed out' }); });
        return;
      }
      _collectAndParse(res, MAX_RESPONSE_BYTES, _parseSo360Html, 'So360', resolve);
    });
    req.on('error', (err) => resolve({ success: false, error: `So360 search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'So360 search timed out' }); });
  });
}

/**
 * 全球搜索:Mojeek(www.mojeek.com),独立自建索引、免 key、直连、无需代理。补国际召回。
 */
async function searchMojeek(query, freshWindow = null) {
  const https = require('https');
  const trimmedQuery = String(query || '').trim().slice(0, 200);
  if (!trimmedQuery) return { success: false, error: 'Search query is empty' };

  let url;
  try { url = require('./search/mojeekEngine').buildMojeekUrl(trimmedQuery); }
  catch { url = ''; }
  if (!url) return { success: false, error: 'Mojeek: empty URL' };
  // 时间过滤:Mojeek 无标准 URL 日期参数,借 duckduckgo 家族的 df= 作通用近似(引擎不认则忽略),
  // 最终仍由 applyRecencyRanking 兜底按日期重排。
  url = _withFreshParam(url, freshWindow, 'duckduckgo');

  return new Promise((resolve) => {
    const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    let req;
    try {
      req = https.get(url, { headers, timeout: 10000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const rUrl = /^https?:\/\//.test(res.headers.location)
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          const rReq = _httpClientFor(rUrl).get(rUrl, { headers, timeout: 10000 },
            (rRes) => _collectAndParse(rRes, MAX_RESPONSE_BYTES, _parseMojeekHtml, 'Mojeek', resolve));
          rReq.on('error', (e) => resolve({ success: false, error: `Mojeek redirect failed: ${e.message}` }));
          rReq.on('timeout', () => { rReq.destroy(); resolve({ success: false, error: 'Mojeek timed out' }); });
          return;
        }
        _collectAndParse(res, MAX_RESPONSE_BYTES, _parseMojeekHtml, 'Mojeek', resolve);
      });
    } catch (err) { resolve({ success: false, error: `Mojeek request error: ${err.message}` }); return; }
    req.on('error', (err) => resolve({ success: false, error: `Mojeek search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Mojeek search timed out' }); });
  });
}

/**
 * HTTP CONNECT 隧道代理请求 DuckDuckGo
 */
function _searchViaProxy(targetUrl, proxyUrl, maxBytes, resolve) {
  const http = require('http');
  const https = require('https');
  const { URL } = require('url');
  const parsed = new URL(targetUrl);
  const proxy = new URL(proxyUrl);

  const connectReq = http.request({
    host: proxy.hostname,
    port: proxy.port || 7890,
    method: 'CONNECT',
    path: `${parsed.hostname}:443`,
    timeout: 10000,
  });

  connectReq.on('connect', (connectRes, socket) => {
    if (connectRes.statusCode !== 200) {
      socket.destroy();
      resolve({ success: false, error: `Proxy CONNECT failed: ${connectRes.statusCode}` });
      return;
    }
    const req = https.get(targetUrl, {
      socket,
      agent: false,
      headers: { 'User-Agent': 'KHY-OS/1.0 (search fallback)' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { res.destroy(); return; }
        data += chunk;
      });
      res.on('end', () => {
        try {
          const results = _parseDuckDuckGoHtml(data);
          if (results.length === 0) {
            resolve({ success: true, results: [], formatted: 'No results found.' });
            return;
          }
          resolve({ success: true, results, formatted: _formatResultsMarkdown(results) });
        } catch (err) {
          resolve({ success: false, error: `Search parse error: ${err.message}` });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, error: `Proxy search failed: ${err.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Proxy search timed out' }); });
  });

  connectReq.on('error', (err) => resolve({ success: false, error: `Proxy connect error: ${err.message}` }));
  connectReq.on('timeout', () => { connectReq.destroy(); resolve({ success: false, error: 'Proxy connect timed out' }); });
  connectReq.end();
}

/**
 * Cross-engine dedup key. Normalizes scheme/host/path so the same page from
 * two engines collapses to one entry. Keeps query string (distinct pages often
 * differ only there); drops fragment, leading www., and trailing slash.
 */
function _dedupKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    // Non-URL (e.g. Baidu-wrapped relative) — fall back to the raw string.
    return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Reciprocal Rank Fusion across multiple ranked result lists. Pure — no I/O.
 *
 * This is the accuracy core: instead of "first engine wins, drop duplicates",
 * every result accumulates a fusion score
 *     score = Σ_engine  weight_engine / (K + rank_in_engine)   // rank from 0
 * so a page surfaced by several independent engines — and ranked highly in each
 * — floats to the top. Cross-engine consensus is the strongest precision signal
 * in metasearch, and the old first-seen dedup threw it away.
 *
 * Each fused item is annotated with the consensus sources:
 *   - engines:     de-duped list of engine names that surfaced it
 *   - engineCount: engines.length
 * Display fields are merged for richness: title/url come from the highest-weight
 * engine that surfaced the item (preserving the original priority intent as a
 * tie-breaker), while snippet takes the LONGEST variant seen (a short snippet
 * from a high-priority engine no longer hides a fuller one from a lower-priority
 * engine — a latent bug in the first-seen path).
 *
 * @param {Array<{engine:string, weight:number, results:object[]}>} perEngine
 * @param {object} [opts]
 * @param {number} [opts.k] - RRF constant (defaults to _rrfK()).
 * @returns {object[]} fused results sorted by descending fusion score
 */
function _fuseRankedLists(perEngine, opts = {}) {
  const K = Number.isFinite(opts.k) && opts.k > 0 ? opts.k : _rrfK();
  // key → aggregate record
  const agg = new Map();
  for (const src of Array.isArray(perEngine) ? perEngine : []) {
    if (!src || !Array.isArray(src.results)) continue;
    const engine = src.engine || 'engine';
    const weight = Number.isFinite(src.weight) ? src.weight : 1;
    src.results.forEach((item, rank) => {
      if (!item || !item.url) return;
      const key = _dedupKey(item.url);
      if (!key) return;
      let rec = agg.get(key);
      if (!rec) {
        rec = { score: 0, engines: [], best: null, bestWeight: -Infinity, longestSnippet: '', order: agg.size };
        agg.set(key, rec);
      }
      rec.score += weight / (K + rank);
      if (!rec.engines.includes(engine)) rec.engines.push(engine);
      // title/url from the highest-weight engine that surfaced this item
      if (weight > rec.bestWeight) { rec.best = item; rec.bestWeight = weight; }
      // snippet: keep the longest variant across engines
      const snip = String(item.snippet || '');
      if (snip.length > rec.longestSnippet.length) rec.longestSnippet = snip;
    });
  }

  const fused = [...agg.values()].map((rec) => ({
    ...rec.best,
    snippet: rec.longestSnippet || (rec.best && rec.best.snippet) || '',
    engines: rec.engines,
    engineCount: rec.engines.length,
    _score: rec.score,
    _order: rec.order,
  }));
  // Descending score; stable tie-break on first-seen order so equal-score items
  // keep engine-priority order (matches the legacy priority-preserving behavior).
  fused.sort((a, b) => (b._score - a._score) || (a._order - b._order));
  // Strip internal sort keys from the public shape.
  return fused.map(({ _score, _order, ...rest }) => rest);
}

/**
 * Merge per-engine Promise.allSettled outcomes into a fused, consensus-ranked
 * result list and collect partial failures. Pure — no I/O — so the fan-out merge
 * logic is unit-testable without network. Signature unchanged for back-compat.
 *
 * Engine weight comes from `fanout[i].weight` when provided; otherwise it is
 * derived from the engine's position (1 - i*0.05) so earlier (higher-priority)
 * engines win score ties — preserving the original priority intent.
 *
 * @param {Array<PromiseSettledResult>} settled - aligned with `fanout` order
 * @param {Array<{engine:string, weight?:number}>} fanout
 * @returns {{merged: object[], partialFailures: {engine:string, message:string}[]}}
 */
function _mergeEngineOutcomes(settled, fanout) {
  const partialFailures = [];
  const perEngine = [];
  settled.forEach((outcome, i) => {
    const engine = (fanout[i] && fanout[i].engine) || `engine${i}`;
    const weight = Number.isFinite(fanout[i] && fanout[i].weight) ? fanout[i].weight : (1 - i * 0.05);
    if (outcome.status === 'rejected') {
      partialFailures.push({ engine, message: String((outcome.reason && outcome.reason.message) || outcome.reason) });
      return;
    }
    const r = outcome.value;
    if (!r || !r.success) {
      if (r && r.error) partialFailures.push({ engine, message: r.error });
      return;
    }
    perEngine.push({ engine, weight, results: r.results || [] });
  });
  const merged = _fuseRankedLists(perEngine);
  return { merged, partialFailures };
}

// Source-type authority order: more authoritative / structured sources first.
// Mirrors the types produced by _classifyDomain (reference/docs/forum/blog/
// news/other) plus 'code' used by the markdown formatter.
const _DIGEST_TYPE_ORDER = ['reference', 'docs', 'code', 'forum', 'blog', 'news', 'other'];
const _DIGEST_TYPE_LABELS = {
  reference: '参考资料', docs: '官方文档', code: '代码',
  forum: '社区问答', blog: '博客文章', news: '新闻', other: '其他',
};

/**
 * Clean a raw snippet for display: collapse whitespace, strip leading source
 * labels / dates that scrapers leave behind, and truncate to a budget.
 * Pure — safe to unit-test.
 */
function _cleanSnippet(snippet, maxLen = 160) {
  let s = String(snippet || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Drop a leading "百度快照"/"来源：xxx"/bare date prefix.
  s = s.replace(/^(百度快照|来源[:：][^\s]+|\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*[-—|]?\s*/u, '').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

/**
 * Organize a flat result[] into a deduped, source-grouped digest. This is the
 * single source of truth for "整理搜索结果" — used by local mode and any other
 * consumer that wants tidy output instead of a raw list.
 *
 * Pure (no I/O): dedupes by canonical URL (reusing _dedupKey), groups by source
 * type in authority order, cleans snippets, and caps per-group + overall.
 *
 * @param {object[]} results - items shaped { title, url, snippet, domain, type }
 * @param {object} [opts]
 * @param {number} [opts.limit=8]        max items overall after dedup
 * @param {number} [opts.perGroup=4]     max items shown per source group
 * @param {number} [opts.snippetLen=160] snippet truncation budget
 * @returns {{ total:number, groups:Array<{type:string,label:string,items:object[]}>, items:object[] }}
 */
function digestResults(results, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 8;
  const perGroup = Number.isFinite(opts.perGroup) && opts.perGroup > 0 ? opts.perGroup : 4;
  const snippetLen = Number.isFinite(opts.snippetLen) && opts.snippetLen > 0 ? opts.snippetLen : 160;

  const seen = new Set();
  const cleaned = [];
  for (const r of Array.isArray(results) ? results : []) {
    const url = String(r && r.url || '').trim();
    const title = String(r && r.title || '').replace(/\s+/g, ' ').trim();
    if (!url || !title) continue;
    const key = _dedupKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      title,
      url,
      snippet: _cleanSnippet(r.snippet, snippetLen),
      domain: String(r.domain || _extractDomain(url) || ''),
      type: _DIGEST_TYPE_ORDER.includes(r.type) ? r.type : 'other',
      // Carry consensus through so tidy output can show it too.
      engines: Array.isArray(r.engines) ? r.engines : undefined,
      engineCount: Number.isFinite(r.engineCount) ? r.engineCount : undefined,
    });
    if (cleaned.length >= limit) break;
  }

  const byType = new Map();
  for (const item of cleaned) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    const bucket = byType.get(item.type);
    if (bucket.length < perGroup) bucket.push(item);
  }

  const groups = _DIGEST_TYPE_ORDER
    .filter(t => byType.has(t))
    .map(t => ({ type: t, label: _DIGEST_TYPE_LABELS[t] || t, items: byType.get(t) }));

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const items = groups.flatMap(g => g.items);
  return { total, groups, items };
}

/**
 * Render a digest as plain (un-colored) numbered text grouped by source.
 * Color rendering lives at the call site (it owns the chalk instance).
 * @param {ReturnType<typeof digestResults>} digest
 * @returns {string}
 */
function formatDigestPlain(digest) {
  if (!digest || !digest.total) return '未找到相关结果。';
  const lines = [];
  let n = 0;
  for (const g of digest.groups) {
    lines.push(`【${g.label}】`);
    for (const it of g.items) {
      n += 1;
      const consensus = it.engineCount >= 2 ? `（${it.engineCount} 个引擎收录）` : '';
      lines.push(`  ${n}. ${it.title}${consensus}`);
      if (it.snippet) lines.push(`     ${it.snippet}`);
      lines.push(`     ${it.url}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}


// ── Engine registry + env-configurable fan-out ─────────────────────
// Single source for the keyless scrapers. weight feeds RRF fusion (higher =
// surfaces earlier on score ties), ordered by直连可靠性/权威度. 新增引擎在此登记
// 即自动并入扇出，无需改 searchUnified（零硬编码）。
const ENGINE_REGISTRY = {
  'baidu': { fn: searchBaidu, weight: 1.00 },        // 国内最稳定，优先
  'bing-cn': { fn: searchDomestic, weight: 0.95 },   // cn.bing.com，无需代理
  'duckduckgo': { fn: searchFallback, weight: 0.90 },// 走代理兜底
  'mojeek': { fn: searchMojeek, weight: 0.88 },      // 独立全球引擎，免 key 直连、无需代理（门控 KHY_SEARCH_MOJEEK）
  'sogou': { fn: searchSogou, weight: 0.85 },        // 搜狗，直连拓宽召回
  'so360': { fn: searchSo360, weight: 0.80 },        // 360 搜索，直连拓宽召回
};
const DEFAULT_ENGINE_ORDER = ['baidu', 'bing-cn', 'duckduckgo', 'mojeek', 'sogou', 'so360'];

/**
 * Mojeek 是否并入本次扇出:门控 KHY_SEARCH_MOJEEK(默认开)。关 → 从扇出剔除,逐字节回退
 * 今日「仅国内 5 引擎」行为。fail-soft:叶子缺失 → 视作开(default-on 语义)。
 * @returns {boolean}
 */
function _mojeekEnabled() {
  try {
    return require('./search/mojeekEngine').isMojeekEnabled(process.env);
  } catch {
    return true; // 叶子不可用 → 保持 default-on,不因缺失而静默丢引擎
  }
}

/**
 * Resolve the active fan-out list from KHY_SEARCH_ENGINES (comma-separated engine
 * names, e.g. "baidu,sogou,so360"). Unknown names are dropped; an empty/invalid
 * selection falls back to the full default set. Pure — unit-testable.
 * @returns {Array<{engine:string, fn:Function, weight:number}>}
 */
function _resolveFanout() {
  const raw = String(process.env.KHY_SEARCH_ENGINES || '').trim();
  let names = DEFAULT_ENGINE_ORDER;
  if (raw) {
    const picked = raw.split(',').map(s => s.trim().toLowerCase()).filter(n => ENGINE_REGISTRY[n]);
    if (picked.length) names = picked;
  }
  // Mojeek 门控(KHY_SEARCH_MOJEEK,默认开):关 → 从扇出剔除,逐字节回退今日「仅国内 5 引擎」。
  // 显式 KHY_SEARCH_ENGINES 命名 mojeek 时同样受此门控约束(关则不跑)。
  const mojeekOn = _mojeekEnabled();
  if (!mojeekOn) names = names.filter(n => n !== 'mojeek');
  const builtins = names.map(name => ({ engine: name, fn: ENGINE_REGISTRY[name].fn, weight: ENGINE_REGISTRY[name].weight }));
  // 运行期声明的额外引擎(env KHY_SEARCH_EXTRA_ENGINES / 数据家 search_engines.json)并入扇出,
  // 无需改源码即可发现 / 接入新站点。与 KHY_SEARCH_ENGINES 的内置裁剪正交;同名以内置为准(去重)。
  const dynamics = _loadDynamicFanout().filter(d => !builtins.some(b => b.engine === d.engine));
  return builtins.concat(dynamics);
}

/**
 * Browser-rendered fallback for when plain HTTP scraping is bot-blocked.
 * Fetches the rendered results page for Bing 中国 then 百度 via playwrightSearch
 * and parses them with the SAME cheerio selectors as the request path. Returns
 * { unavailable: true } when playwright isn't installed so the caller skips it.
 */
async function _playwrightFanout(query, limit = DEFAULT_RESULTS, freshWindow = null) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { success: false, error: 'Search query is empty', partialFailures: [] };

  const ENGINES = [
    { engine: 'bing-cn(pw)', weight: 0.95, sel: '#b_results', parse: _parseBingHtml,
      url: _withFreshParam(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hans&mkt=zh-CN`, freshWindow, 'bing-cn') },
    { engine: 'baidu(pw)', weight: 1.00, sel: '#content_left', parse: _parseBaiduHtml,
      url: _withFreshParam(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20&ie=utf-8`, freshWindow, 'baidu') },
  ];

  const perEngine = [];
  const partialFailures = [];
  let collected = 0;
  for (const e of ENGINES) {
    const res = await playwrightSearch.fetchRenderedHtml(e.url, { waitForSelector: e.sel });
    if (res.unavailable) return { unavailable: true, partialFailures };
    if (!res.success) { partialFailures.push({ engine: e.engine, message: res.error }); continue; }
    let items = [];
    try { items = e.parse(res.html) || []; }
    catch (err) { partialFailures.push({ engine: e.engine, message: `parse: ${err.message}` }); }
    if (items.length) { perEngine.push({ engine: e.engine, weight: e.weight, results: items }); collected += items.length; }
    if (collected >= RESULTS_CEILING) break; // enough candidates across engines — stop fetching
  }

  // Fuse with the same RRF logic as the request path so consensus annotation and
  // ranking are consistent across both fast and browser paths.
  const merged = _fuseRankedLists(perEngine);

  if (merged.length > 0) {
    const top = merged.slice(0, limit);
    return { success: true, results: top, formatted: _formatResultsMarkdown(top), partialFailures };
  }
  return {
    success: false,
    error: partialFailures.map(f => f.message).join(' | ') || 'Playwright: no results',
    partialFailures,
  };
}

/**
 * Unified search — parallel fan-out across the keyless scrapers (百度 / Bing 中国 /
 * DuckDuckGo), merged + deduped by normalized URL. Wall-clock is the slowest
 * single engine rather than the sum of a serial fallback chain, and a partial
 * engine failure no longer hides the others' results. Kiro MCP stays a
 * sequential last resort (auth-gated, ~30s) so it never gates the fast path.
 */
async function searchUnified(query, opts = {}) {
  const partialFailures = [];
  const limit = _resolveLimit(opts); // 按需条数；引擎层仍按 ceiling 召回，末端再切片
  const mode = playwrightSearch.getSearchMode(); // request | auto | playwright
  let playwrightUnavailable = false; // 追踪：浏览器路径因 playwright 缺失而不可用

  // 时间窗口:显式 opts.freshness 优先,否则按 query 自动识别(把新鲜度硬编码进搜索)。
  const freshWindow = _resolveFreshWindow(query, opts);

  // Forced browser mode: try Playwright first, fall through if unavailable/empty.
  if (mode === 'playwright') {
    const pw = await _playwrightFanout(query, limit, freshWindow);
    if (pw.partialFailures) partialFailures.push(...pw.partialFailures);
    if (pw.unavailable) playwrightUnavailable = true;
    if (pw.success && pw.results.length) {
      const ranked = _applyRecency(pw.results, freshWindow);
      return _withDiscovery({ success: true, results: ranked, formatted: _formatResultsMarkdown(ranked), partialFailures, freshness: freshWindow || undefined }, query);
    }
  }

  const FANOUT = _resolveFanout();

  const settled = await Promise.allSettled(FANOUT.map(({ fn }) => fn(query, freshWindow)));

  const { merged, partialFailures: fanoutFailures } = _mergeEngineOutcomes(settled, FANOUT);
  partialFailures.push(...fanoutFailures);

  if (merged.length > 0) {
    const ranked = _applyRecency(merged, freshWindow);
    const top = ranked.slice(0, limit);
    return _withDiscovery({ success: true, results: top, formatted: _formatResultsMarkdown(top), partialFailures, freshness: freshWindow || undefined }, query);
  }

  // Request scrapers came up empty (often a bot wall) → browser fallback in
  // auto mode. 'request' mode opts out; 'playwright' mode already tried above.
  if (mode === 'auto') {
    const pw = await _playwrightFanout(query, limit, freshWindow);
    if (pw.partialFailures) partialFailures.push(...pw.partialFailures);
    if (pw.unavailable) playwrightUnavailable = true;
    if (pw.success && pw.results.length) {
      const ranked = _applyRecency(pw.results, freshWindow);
      return _withDiscovery({ success: true, results: ranked, formatted: _formatResultsMarkdown(ranked), partialFailures, freshness: freshWindow || undefined }, query);
    }
  }

  // All scrapers empty/failed → fall back to Kiro MCP (heavier, auth-gated).
  if (isAvailable()) {
    const result = await search(query, { ...opts, freshness: freshWindow });
    if (result.success) {
      const ranked = _applyRecency(result.results, freshWindow);
      return _withDiscovery({ ...result, results: ranked, formatted: _formatResultsMarkdown(ranked), partialFailures, freshness: freshWindow || undefined }, query);
    }
    if (result.error) partialFailures.push({ engine: 'kiro', message: result.error });
  }

  // Detect network-level failures (TLS disconnect, ECONNREFUSED, timeout)
  const allErrors = partialFailures.map(f => f.message).join(' | ');
  const isNetworkIssue = /TLS|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket.*disconnect|network/i.test(allErrors);
  let hint = isNetworkIssue
    ? '当前环境无法访问外网搜索引擎。请配置代理: export HTTPS_PROXY=http://127.0.0.1:7890 或通过 khy gateway config 设置代理。'
    : '';

  // cheerio missing → the keyless scrapers (百度/Bing/DuckDuckGo) can't parse
  // results at all. Surface this first so the user fixes the real cause.
  if (!hint && !isHtmlParsingAvailable()) {
    hint = 'HTML 解析依赖 cheerio 未安装，无 key 搜索引擎（百度/Bing/DuckDuckGo）已降级。'
      + '请在 services/backend 目录执行 npm install，或配置 Kiro 令牌使用 MCP 搜索。';
  }

  // Plan A — 如实上抛缺失依赖：只有当**所有**搜索路径都已失败后，才给失败结果打上
  // depId，让 executeTool 的依赖自愈漏斗能询问安装并重试一次。这里打标而非在
  // _loadCheerio/_loadPlaywright 的 catch 里硬抛，是刻意保留上方的优雅降级
  // （带 key 引擎 / Kiro MCP 仍能兜底）——只在真正无路可走时才标记缺失的可选依赖。
  //   - cheerio 缺失是更深的根因（连解析都做不了）→ 优先标 cheerio；
  //   - 仅当强制 playwright 模式下浏览器因 playwright 缺失而不可用，才标 playwright。
  const failure = {
    success: false,
    error: hint || allErrors || 'All search methods failed',
    partialFailures,
  };
  if (!isHtmlParsingAvailable()) failure.depId = 'cheerio';
  else if (mode === 'playwright' && playwrightUnavailable) failure.depId = 'playwright';
  return failure;
}

module.exports = { search: searchUnified, searchDirect: search, searchFallback, searchDomestic, searchBaidu, searchSogou, searchSo360, searchMojeek, isAvailable, formatResults, isHtmlParsingAvailable, digestResults, formatDigestPlain };

// Internal parsers exposed for unit testing only (no network involved).
module.exports.__parsersForTests = {
  parseBaiduHtml: _parseBaiduHtml,
  parseBingHtml: _parseBingHtml,
  parseDuckDuckGoHtml: _parseDuckDuckGoHtml,
  parseSogouHtml: _parseSogouHtml,
  parseSo360Html: _parseSo360Html,
  parseMojeekHtml: _parseMojeekHtml,
  parseGenericHtml: _parseGenericHtml,
  makeDynamicEngine: _makeDynamicEngine,
  loadDynamicFanout: _loadDynamicFanout,
  withDiscovery: _withDiscovery,
  dedupKey: _dedupKey,
  mergeEngineOutcomes: _mergeEngineOutcomes,
  fuseRankedLists: _fuseRankedLists,
  resolveFanout: _resolveFanout,
  mojeekEnabled: _mojeekEnabled,
  playwrightFanout: _playwrightFanout,
  cleanSnippet: _cleanSnippet,
  httpClientFor: _httpClientFor,
  resolveLimit: _resolveLimit,
};
