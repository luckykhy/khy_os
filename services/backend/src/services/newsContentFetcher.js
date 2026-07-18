'use strict';

/**
 * newsContentFetcher — fill in real article body text for news/search results.
 *
 * Why this exists: the keyless scrapers (百度/Bing/DuckDuckGo) only ever yield a
 * SERP `snippet`, and百度 frequently returns none at all — so the `news` tool
 * degraded to a bare list of titles ("1. 最新新闻事件报道_今日热点新闻") with no
 * readable body. This module closes that gap: for the top results whose snippet
 * is missing or too short, it fetches the article URL and extracts the main
 * text, writing it back into `article.content`.
 *
 * Design constraints (mirrors the rest of the search subsystem):
 *  - SAFE: every hop is SSRF-validated via urlSafety before a socket opens —
 *    public-looking hosts that resolve/redirect to internal targets are rejected.
 *  - CROSS-HOST REDIRECTS: 百度 wraps each result as www.baidu.com/link?url=...
 *    which 302s to the real (different-host) article. Unlike WebFetchTool — which
 *    deliberately refuses cross-host redirects for a user-supplied URL — here the
 *    redirect IS the mechanism, so we follow it (re-validating each hop).
 *  - FAIL-SOFT: enrichment is best-effort. Any fetch/parse/timeout failure leaves
 *    the original snippet untouched; this never throws and never breaks the news
 *    backbone. A miss just means "snippet only", exactly as before.
 *  - BOUNDED: only the top N short-snippet articles are fetched, with a per-fetch
 *    timeout, a small concurrency pool, and a hard response-size cap.
 *  - OPT-OUT, not opt-in: on by default so news actually has bodies; set
 *    KHY_NEWS_FETCH_CONTENT=0 (or false/off) to disable.
 *
 * Env knobs:
 *  - KHY_NEWS_FETCH_CONTENT     = 0|false|off to disable (default: enabled)
 *  - KHY_NEWS_FETCH_MAX         = max articles to enrich (default 3)
 *  - KHY_NEWS_FETCH_TIMEOUT_MS  = per-fetch timeout (default 8000)
 *  - KHY_NEWS_FETCH_CONCURRENCY = parallel fetches (default 3)
 *  - KHY_NEWS_FETCH_MIN_SNIPPET = enrich snippets shorter than this (default 80)
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { assertPublicHttpUrlResolved } = require('./urlSafety');

const MAX_RESPONSE_BYTES = 1.5 * 1024 * 1024; // 1.5 MB cap per article
const MAX_REDIRECTS = 4;
const EXTRACT_MAX_CHARS = 1200; // body we keep per article (summarizer slices further)

// ── Env-driven config (read per call so tests/runtime can flip it) ──────
function _truthyDisabled(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off' || s === 'no';
}

function getConfig() {
  const num = (envName, def, lo, hi) => {
    const n = Number(process.env[envName]);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };
  return {
    enabled: !_truthyDisabled(process.env.KHY_NEWS_FETCH_CONTENT),
    max: num('KHY_NEWS_FETCH_MAX', 3, 0, 10),
    timeoutMs: num('KHY_NEWS_FETCH_TIMEOUT_MS', 8000, 1000, 30000),
    concurrency: num('KHY_NEWS_FETCH_CONCURRENCY', 3, 1, 6),
    minSnippet: num('KHY_NEWS_FETCH_MIN_SNIPPET', 80, 0, 1000),
  };
}

// ── Proxy resolution (same precedence as webSearchService/WebFetchTool) ──
function _getProxyUrl() {
  try {
    const pcs = require('./proxyConfigService');
    const active = pcs.getActiveProxy ? pcs.getActiveProxy() : null;
    if (active) return typeof active === 'string' ? active : active.url || null;
  } catch { /* ignore */ }
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

// ── HTML → plain text extraction ────────────────────────────────────────
// Reuse WebFetchTool's structured HTML→markdown converter (single source of
// truth for that logic) when available; fall back to a minimal tag-stripper so
// this module never hard-depends on a private method.
let _webFetch = null;
function _extractText(html) {
  if (!html) return '';
  if (_webFetch === null) {
    try { _webFetch = require('../tools/WebFetchTool'); }
    catch { _webFetch = false; }
  }
  if (_webFetch && typeof _webFetch._htmlToMarkdown === 'function') {
    try {
      const { content } = _webFetch._htmlToMarkdown(html);
      if (content) return content;
    } catch { /* fall through to minimal stripper */ }
  }
  // Minimal fallback: drop noise blocks, strip tags, collapse whitespace.
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Condense extracted page text into a compact body worth showing. Drops the
 * synthetic "Page Structure" TOC WebFetchTool prepends and very short nav
 * fragments, keeping the first substantive lines up to EXTRACT_MAX_CHARS.
 * @param {string} text
 * @returns {string}
 */
function _condense(text) {
  if (!text) return '';
  let t = String(text);
  // Strip the "## Page Structure ... ---" TOC block WebFetchTool may prepend.
  t = t.replace(/^##\s*Page Structure[\s\S]*?\n---\n/i, '');
  const lines = t.split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && l.length >= 8 && !/^#{1,6}\s*$/.test(l));
  const body = lines.join(' ').replace(/\s+/g, ' ').trim();
  return body.slice(0, EXTRACT_MAX_CHARS);
}

// ── Single fetch hop (no redirect following) ────────────────────────────
// Resolves to { html } | { redirect } | { error }. Never rejects.
function _fetchHop(targetUrl, proxyUrl, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const target = new URL(targetUrl);
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };

    const onResponse = (res) => {
      // Redirect → surface the resolved absolute location to the caller.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain
        try {
          const next = new URL(res.headers.location, targetUrl).toString();
          done({ redirect: next });
        } catch {
          done({ error: `bad redirect: ${res.headers.location}` });
        }
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        done({ error: `HTTP ${res.statusCode}` });
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) { res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done({ html: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', (err) => done({ error: err.message }));
    };

    try {
      if (proxyUrl && target.protocol === 'https:') {
        // HTTP CONNECT tunnel for https through the proxy.
        const proxy = new URL(proxyUrl);
        const connectReq = http.request({
          host: proxy.hostname,
          port: proxy.port || 7890,
          method: 'CONNECT',
          path: `${target.hostname}:${target.port || 443}`,
          timeout: timeoutMs,
        });
        connectReq.on('connect', (connectRes, socket) => {
          if (connectRes.statusCode !== 200) {
            socket.destroy();
            done({ error: `proxy CONNECT ${connectRes.statusCode}` });
            return;
          }
          const req = https.get(targetUrl, { socket, agent: false, headers: reqHeaders, timeout: timeoutMs }, onResponse);
          req.on('error', (err) => done({ error: err.message }));
          req.on('timeout', () => { req.destroy(); done({ error: 'timeout' }); });
        });
        connectReq.on('error', (err) => done({ error: `proxy: ${err.message}` }));
        connectReq.on('timeout', () => { connectReq.destroy(); done({ error: 'proxy timeout' }); });
        connectReq.end();
        return;
      }
      const client = target.protocol === 'https:' ? https : http;
      const req = client.get(targetUrl, { headers: reqHeaders, timeout: timeoutMs }, onResponse);
      req.on('error', (err) => done({ error: err.message }));
      req.on('timeout', () => { req.destroy(); done({ error: 'timeout' }); });
    } catch (err) {
      done({ error: err.message });
    }
  });
}

/**
 * Fetch an article URL, following redirects (cross-host allowed — 百度 link?url=
 * legitimately crosses hosts), SSRF-validating every hop. Returns the extracted
 * body text, or '' on any failure. Never throws.
 * @param {string} url
 * @param {{proxyUrl?: string|null, timeoutMs?: number}} [opts]
 * @returns {Promise<string>}
 */
async function fetchArticleText(url, opts = {}) {
  const proxyUrl = opts.proxyUrl !== undefined ? opts.proxyUrl : _getProxyUrl();
  const timeoutMs = opts.timeoutMs || getConfig().timeoutMs;

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Re-validate every hop: a public host can redirect into the internal net.
    try {
      await assertPublicHttpUrlResolved(current, 'news content URL');
    } catch {
      return '';
    }
    const res = await _fetchHop(current, proxyUrl, timeoutMs);
    if (res.html) return _condense(_extractText(res.html));
    if (res.redirect) { current = res.redirect; continue; }
    return ''; // error
  }
  return ''; // too many redirects
}

// ── Bounded-concurrency pool ────────────────────────────────────────────
async function _runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch { results[i] = undefined; }
    }
  }
  const lanes = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) lanes.push(lane());
  await Promise.all(lanes);
  return results;
}

/**
 * Enrich an article list in place-style (returns a new array) by fetching real
 * body text for the top results whose snippet is missing/short. Best-effort:
 * articles that can't be fetched keep their original content untouched.
 *
 * @param {Array<{title?,content?,url?}>} articles
 * @param {object} [opts] - overrides for config (mainly for tests)
 * @returns {Promise<{articles: Array, meta: {attempted:number, enriched:number, enabled:boolean}}>}
 */
async function enrichArticles(articles, opts = {}) {
  const cfg = { ...getConfig(), ...opts };
  const list = Array.isArray(articles) ? articles.slice() : [];
  const meta = { enabled: cfg.enabled, attempted: 0, enriched: 0 };
  if (!cfg.enabled || cfg.max === 0 || list.length === 0) return { articles: list, meta };

  // Candidates: top results with a fetchable http(s) URL and a too-short snippet.
  const candidates = [];
  for (let i = 0; i < list.length && candidates.length < cfg.max; i++) {
    const a = list[i];
    const url = a && typeof a.url === 'string' ? a.url.trim() : '';
    const snippet = String((a && a.content) || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (snippet.length >= cfg.minSnippet) continue;
    candidates.push({ idx: i, url });
  }
  if (candidates.length === 0) return { articles: list, meta };
  meta.attempted = candidates.length;

  // opts.fetchText lets tests inject a hermetic fetcher (default = real network).
  const fetchText = typeof opts.fetchText === 'function'
    ? opts.fetchText
    : (url) => fetchArticleText(url, { proxyUrl: _getProxyUrl(), timeoutMs: cfg.timeoutMs });
  const fetched = await _runPool(candidates, (c) => fetchText(c.url), cfg.concurrency);

  candidates.forEach((c, k) => {
    const body = String(fetched[k] || '').trim();
    // Only overwrite when we got something meaningfully longer than the snippet.
    const existing = String(list[c.idx].content || '').trim();
    if (body && body.length > existing.length) {
      list[c.idx] = { ...list[c.idx], content: body };
      meta.enriched += 1;
    }
  });

  return { articles: list, meta };
}

module.exports = { enrichArticles, fetchArticleText, getConfig };
// Internal helpers exposed for unit testing only.
module.exports.__internals = { _condense, _extractText, _runPool, _truthyDisabled };
