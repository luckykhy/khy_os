'use strict';

/**
 * packageRegistryService.js — 查询公共包仓库(npm / PyPI)的**纯网络叶子**。
 *
 * goal「khy 应能查看 pip/npm 仓库;当用户问『仓库里有没有合适的开源仓库/包』时 khy 要知道」。
 * 现状缺口(取证 2026-07):
 *   - `tools/manageDeps.js` 只在**本地项目**里 install/add/remove/outdated,不查仓库发现包;
 *   - `services/dependency/registry.js` 是**自愈用的 curated 依赖表**,不是活的仓库检索。
 * 故 AI agent 没有任何「按关键词/名字查 npm/PyPI 有没有合适的包」的可调面。本叶子补这个面。
 *
 * 能力(action × registry):
 *   - npm  search → https://registry.npmjs.org/-/v1/search  (官方 JSON,干净稳定)
 *   - npm  info   → https://registry.npmjs.org/<name>       (官方 JSON,读 dist-tags.latest)
 *   - pypi info   → https://pypi.org/pypi/<name>/json        (官方 JSON,干净稳定)
 *   - pypi search → PyPI 官方 /search/ 页现为 **JS 挑战页**、服务端不再渲染结果(实证:
 *                   返回 ~3KB CSP 挑战页、零 package-snippet)。故**诚实降级**为
 *                   「用内部 webSearchService 站内搜 pypi.org/project + JSON API 富集」的
 *                   最佳努力,并在结果里标注 method='web-search-fallback'。绝不伪造。
 *
 * 红线:
 *   - 只读、**绝不抛**(任何内部失败 → {success:false, error})。
 *   - 只对固定**主机白名单**(registry.npmjs.org / pypi.org)发 GET;query 仅经 URL 编码,
 *     **绝不进入 shell、绝不拼命令**(与命令注入面物理隔离)。
 *   - 门控 `KHY_PACKAGE_REGISTRY` 默认开;显式 0/false/off/no 关 → {success:false,disabled:true}。
 *   - 依赖注入 `_fetch` / `_webSearch` 供测试,默认走 global fetch(Node18+)/ webSearchService。
 */

const NPM_HOST = 'registry.npmjs.org';
const PYPI_HOST = 'pypi.org';
const ALLOWED_HOSTS = new Set([NPM_HOST, PYPI_HOST]);

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_QUERY_LEN = 200;

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// trim+小写 nullish-安全规整单一真源 utils/normLower。
const _norm = require('../utils/normLower');

/** 门控:默认开,仅显式 0/false/off/no 才关。 */
function isEnabled(env = process.env) {
  return !_FALSY.has(_norm(env && env.KHY_PACKAGE_REGISTRY));
}

function _clampLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(v)));
}

/** 只允许白名单主机的 https GET,防 SSRF / 主机逃逸。 */
function _assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`refusing non-https url: ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.host)) throw new Error(`host not in allowlist: ${u.host}`);
  return u;
}

/** 单次 GET → JSON。绝不抛到调用方:失败以 {ok:false} 返回。 */
async function _getJson(url, { fetchImpl, timeoutMs }) {
  try {
    _assertAllowed(url);
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, status: 0, error: 'fetch unavailable in this runtime' };
  let signal;
  try {
    signal = AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS);
  } catch { /* older runtime: no AbortSignal.timeout — fetch without signal */ }
  try {
    const res = await doFetch(url, {
      signal,
      headers: { Accept: 'application/json', 'User-Agent': 'khy-os-registry/1.0' },
    });
    const status = res && typeof res.status === 'number' ? res.status : 0;
    if (!res || !res.ok) return { ok: false, status, error: `HTTP ${status}` };
    const json = await res.json();
    return { ok: true, status, json };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err) };
  }
}

// ── npm ────────────────────────────────────────────────────────────────────

function _npmPackageFromSearchObject(obj) {
  const p = (obj && obj.package) || {};
  const links = p.links || {};
  return {
    name: p.name || '',
    version: p.version || '',
    description: (p.description || '').slice(0, 500),
    keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 12) : [],
    homepage: links.homepage || '',
    repository: links.repository || '',
    npm: links.npm || (p.name ? `https://www.npmjs.com/package/${p.name}` : ''),
    publisher: (p.publisher && p.publisher.username) || '',
    date: p.date || '',
    score: obj && obj.score && typeof obj.score.final === 'number' ? Number(obj.score.final.toFixed(3)) : null,
  };
}

async function _npmSearch(query, limit, ctx) {
  const url = `https://${NPM_HOST}/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`;
  const r = await _getJson(url, ctx);
  if (!r.ok) return { success: false, registry: 'npm', action: 'search', query, error: r.error, results: [] };
  const objects = Array.isArray(r.json && r.json.objects) ? r.json.objects : [];
  return {
    success: true,
    registry: 'npm',
    action: 'search',
    query,
    total: typeof r.json.total === 'number' ? r.json.total : objects.length,
    results: objects.slice(0, limit).map(_npmPackageFromSearchObject),
  };
}

async function _npmInfo(name, ctx) {
  // scoped 名(@scope/name)里的 `/` 编码为 %2f;registry 接受该形式。
  const enc = String(name).replace(/\//g, '%2f');
  const url = `https://${NPM_HOST}/${enc}`;
  const r = await _getJson(url, ctx);
  if (!r.ok) {
    const notFound = r.status === 404;
    return {
      success: false, registry: 'npm', action: 'info', query: name,
      notFound, error: notFound ? `npm package not found: ${name}` : r.error,
    };
  }
  const j = r.json || {};
  const latest = (j['dist-tags'] && j['dist-tags'].latest) || '';
  const v = (j.versions && j.versions[latest]) || {};
  const repo = v.repository || j.repository || {};
  return {
    success: true, registry: 'npm', action: 'info', query: name,
    package: {
      name: j.name || name,
      version: latest,
      description: (v.description || j.description || '').slice(0, 500),
      homepage: v.homepage || j.homepage || '',
      license: typeof v.license === 'string' ? v.license : (v.license && v.license.type) || j.license || '',
      repository: (repo && (repo.url || repo)) || '',
      keywords: Array.isArray(v.keywords || j.keywords) ? (v.keywords || j.keywords).slice(0, 12) : [],
      npm: `https://www.npmjs.com/package/${j.name || name}`,
    },
  };
}

// ── PyPI ─────────────────────────────────────────────────────────────────────

function _pypiPackageFromJson(j, name) {
  const info = (j && j.info) || {};
  const projectUrls = info.project_urls || {};
  return {
    name: info.name || name || '',
    version: info.version || '',
    description: (info.summary || '').slice(0, 500),
    homepage: info.home_page || projectUrls.Homepage || projectUrls.Home || '',
    license: (typeof info.license === 'string' ? info.license : '') || (info.classifiers || []).find(c => /^License ::/.test(c)) || '',
    requiresPython: info.requires_python || '',
    author: info.author || '',
    pypi: `https://pypi.org/project/${info.name || name}/`,
  };
}

async function _pypiInfo(name, ctx) {
  const url = `https://${PYPI_HOST}/pypi/${encodeURIComponent(String(name))}/json`;
  const r = await _getJson(url, ctx);
  if (!r.ok) {
    const notFound = r.status === 404;
    return {
      success: false, registry: 'pypi', action: 'info', query: name,
      notFound, error: notFound ? `PyPI package not found: ${name}` : r.error,
    };
  }
  return { success: true, registry: 'pypi', action: 'info', query: name, package: _pypiPackageFromJson(r.json, name) };
}

/** 从 web 搜索结果 URL 里抽 pypi.org/project/<name> 的包名(去重、保序)。 */
function _extractPypiNames(results) {
  const names = [];
  const seen = new Set();
  for (const item of Array.isArray(results) ? results : []) {
    const url = (item && (item.url || item.link)) || '';
    const m = /pypi\.org\/project\/([A-Za-z0-9._-]+)/i.exec(url);
    if (m && m[1]) {
      const nm = m[1].toLowerCase();
      if (!seen.has(nm)) { seen.add(nm); names.push(m[1]); }
    }
  }
  return names;
}

/**
 * PyPI 关键词搜索的诚实降级:PyPI 官方搜索页服务端不再渲染结果(JS 挑战页),
 * 故用内部 webSearchService 站内搜 `pypi.org/project`,抽包名,再逐一 JSON API 富集。
 * webSearch 不可用 / 无命中 → 诚实提示改用 action:'info' 精确查名或提供确切包名。
 */
async function _pypiSearch(query, limit, ctx) {
  const webSearch = ctx.webSearch;
  if (typeof webSearch !== 'function') {
    return {
      success: false, registry: 'pypi', action: 'search', query, method: 'unavailable', results: [],
      error: 'PyPI 无公开的关键词搜索 JSON API,且本会话 web 搜索不可用。请改用 action:"info" 并给出确切包名。',
    };
  }
  let searchRes;
  try {
    searchRes = await webSearch(`${query} site:pypi.org`, { count: Math.max(limit * 2, 10) });
  } catch (err) {
    return {
      success: false, registry: 'pypi', action: 'search', query, method: 'web-search-fallback', results: [],
      error: `web 搜索失败:${(err && err.message) || String(err)}`,
    };
  }
  if (!searchRes || searchRes.success === false) {
    return {
      success: false, registry: 'pypi', action: 'search', query, method: 'web-search-fallback', results: [],
      error: (searchRes && searchRes.error) || 'web 搜索无结果', depId: searchRes && searchRes.depId,
    };
  }
  const names = _extractPypiNames(searchRes.results).slice(0, limit);
  if (names.length === 0) {
    return {
      success: true, registry: 'pypi', action: 'search', query, method: 'web-search-fallback', results: [],
      note: '站内搜索未从结果中解析到 pypi.org/project 包名。请改用 action:"info" 并给出确切包名。',
    };
  }
  const infos = await Promise.all(names.map(nm => _pypiInfo(nm, ctx)));
  const results = infos.filter(x => x && x.success && x.package).map(x => x.package);
  return {
    success: true, registry: 'pypi', action: 'search', query, method: 'web-search-fallback',
    note: 'PyPI 无公开关键词搜索 API,此结果经 web 站内搜索 + PyPI JSON API 富集(最佳努力,非官方全量检索)。',
    results,
  };
}

// ── 顶层入口 ─────────────────────────────────────────────────────────────────

/**
 * 查询包仓库。
 * @param {object} opts
 * @param {'npm'|'pypi'|'auto'} opts.registry  目标仓库;'auto' = 两者都查(search)/先 npm 再 pypi(info)。
 * @param {string} opts.query   关键词(search)或确切包名(info)。
 * @param {'search'|'info'} [opts.action='search']
 * @param {number} [opts.limit=10]
 * @param {function} [opts._fetch]      注入 fetch(测试)。
 * @param {function} [opts._webSearch]  注入 web 搜索(测试);签名 (query, {count}) => {success,results:[{url,title,snippet}]}。
 * @param {object}   [opts.env=process.env]
 * @returns {Promise<object>} 结构化结果,绝不抛。
 */
async function queryRegistry(opts = {}) {
  const env = opts.env || process.env;
  if (!isEnabled(env)) {
    return { success: false, disabled: true, error: 'package registry lookups disabled (KHY_PACKAGE_REGISTRY=0)' };
  }

  const rawQuery = typeof opts.query === 'string' ? opts.query.trim().slice(0, MAX_QUERY_LEN) : '';
  if (!rawQuery) return { success: false, error: 'query is required (keyword for search, exact name for info)' };

  const action = opts.action === 'info' ? 'info' : 'search';
  const registry = ['npm', 'pypi', 'auto'].includes(opts.registry) ? opts.registry : 'auto';
  const limit = _clampLimit(opts.limit);

  // 解析 web 搜索实现(注入优先;否则惰性取 webSearchService.search,fail-soft)。
  let webSearch = typeof opts._webSearch === 'function' ? opts._webSearch : null;
  if (!webSearch) {
    try {
      const ws = require('./webSearchService');
      if (ws && typeof ws.search === 'function') webSearch = ws.search;
    } catch { /* web search unavailable — pypi search degrades honestly */ }
  }

  const ctx = {
    fetchImpl: typeof opts._fetch === 'function' ? opts._fetch : null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    webSearch,
  };

  try {
    if (action === 'info') {
      if (registry === 'npm') return await _npmInfo(rawQuery, ctx);
      if (registry === 'pypi') return await _pypiInfo(rawQuery, ctx);
      // auto: 先 npm,未命中再 pypi。
      const npm = await _npmInfo(rawQuery, ctx);
      if (npm.success) return npm;
      const pypi = await _pypiInfo(rawQuery, ctx);
      if (pypi.success) return pypi;
      return {
        success: false, registry: 'auto', action: 'info', query: rawQuery,
        error: `包名 "${rawQuery}" 在 npm 与 PyPI 均未找到`, npm, pypi,
      };
    }

    // action === 'search'
    if (registry === 'npm') return await _npmSearch(rawQuery, limit, ctx);
    if (registry === 'pypi') return await _pypiSearch(rawQuery, limit, ctx);
    // auto: 两者并行,合并。
    const [npm, pypi] = await Promise.all([
      _npmSearch(rawQuery, limit, ctx),
      _pypiSearch(rawQuery, limit, ctx),
    ]);
    return {
      success: !!(npm.success || pypi.success),
      registry: 'auto',
      action: 'search',
      query: rawQuery,
      npm,
      pypi,
    };
  } catch (err) {
    // 顶层兜底:任何未预期异常都转成结构化失败,永不冒泡打断会话。
    return { success: false, registry, action, query: rawQuery, error: `registry query failed: ${(err && err.message) || String(err)}` };
  }
}

module.exports = {
  isEnabled,
  queryRegistry,
  // 导出内部件供测试(不视为稳定 API)。
  _extractPypiNames,
  _npmPackageFromSearchObject,
  _pypiPackageFromJson,
  ALLOWED_HOSTS,
};
