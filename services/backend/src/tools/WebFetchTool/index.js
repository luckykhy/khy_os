/**
 * WebFetchTool — URL content fetching with structured markdown extraction.
 *
 * Fetches content from a URL, converts HTML to structured markdown
 * (preserving headings, links, code blocks, lists, tables),
 * and returns navigable content the model can reason about.
 */
const { BaseTool } = require('../_baseTool');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { assertPublicHttpUrlResolved } = require('../../services/urlSafety');
const { resolveToolTimeoutMs } = require('../_toolTimeout');
const webFetchDeadline = require('./webFetchDeadline');

const FETCH_TIMEOUT_MS = 30000;
const MAX_CONTENT_SIZE = 500 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CACHE_MAX_ENTRIES = 20;

// ── In-memory cache ─────────────────────────────────────────────────
const _cache = new Map();

function _cacheGet(url) {
  const entry = _cache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(url);
    return null;
  }
  return entry.data;
}

function _cacheSet(url, data) {
  // LRU eviction
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(url, { data, ts: Date.now() });
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

class WebFetchTool extends BaseTool {
  static toolName = 'WebFetch';
  static category = 'data';
  static risk = 'low';
  // `curl` intentionally omitted — it denotes arbitrary HTTP verbs and is owned
  // by the `httpRequest` tool (REST client). WebFetch is a GET-only page reader,
  // so it keeps only the page-fetch aliases. Splitting the previously-shared
  // `fetch_url`/`curl` aliases gives each normalized key a single owner, making
  // tool resolution deterministic (see toolContract auditor + toolCalling._toolKey).
  static aliases = ['web_fetch', 'fetch_url'];
  static searchHint = 'fetch url web page content download read website';
  static shouldDefer = false;
  static maxResultSizeChars = 40000;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Fetches content from a URL and returns it as structured markdown text.

Common workflow: First search the web with WebSearch to find relevant pages, then use WebFetch to read the full content of the most promising results.

Usage notes:
- Returns structured content with headings, links, code blocks, and lists preserved
- Links in the content are preserved as [text](URL) — you can fetch linked pages for deeper information
- The URL must be a fully-formed valid URL
- HTTP URLs will be automatically upgraded to HTTPS
- Results may be truncated if the content is very large (500KB limit)
- Includes a 15-minute cache for faster repeated access
- When a URL redirects to a different host, the tool will inform you with the redirect URL
- For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api)
- WILL FAIL for authenticated/private URLs — use specialized tools for Google Docs, Jira, etc.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to fetch content from',
        },
        prompt: {
          type: 'string',
          description: 'Optional prompt describing what information to extract from the page',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional hard timeout in milliseconds for the fetch (default 30000, range 1000–120000). Set a lower value when you expect a slow/unresponsive site and do not want to wait.',
        },
      },
      required: ['url'],
    };
  }

  getActivityDescription(input) {
    try {
      const url = new URL(input.url);
      return `抓取网页：${url.hostname}`;
    } catch {
      return '抓取网页';
    }
  }

  async execute(params, context) {
    let { url, prompt: userPrompt } = params;
    // 模型可设硬超时(默认 30s,clamp[1000,120000]);门控关 → 逐字节回退 FETCH_TIMEOUT_MS。
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params && params.timeoutMs,
      envKey: 'KHY_WEBFETCH_TIMEOUT_MS',
      defaultMs: FETCH_TIMEOUT_MS,
      min: 1000,
      max: 120000,
    });

    // Validate and normalize URL
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:') {
        parsed.protocol = 'https:';
        url = parsed.toString();
      }
    } catch {
      return { success: false, error: `Invalid URL: ${url}` };
    }

    // Check cache (a cached entry was already SSRF-validated when first fetched)
    const cached = _cacheGet(url);
    if (cached) return { ...cached, _cached: true };

    // ── 总墙钟 + abort 接线(webFetchDeadline;门控 KHY_WEBFETCH_HARD_DEADLINE 默认开)──
    // Node 的 `timeout` 只是 socket 空闲超时,慢站点滴数据/同源重定向每跳都会重置它,导致抓取
    // 一路骑到外层 120s 硬顶 = 感知卡死。这里给整条抓取(含重定向链)套一个**单一总墙钟**
    // AbortController:预算耗尽 → controller.abort() 直接销毁 socket;并把 loop 传入的父
    // abort 信号(ESC)链到同一 controller,让 ESC 真正打断在途请求。门控关 → parentSignal 为
    // null、不建 controller/定时器、请求 options 不含 signal 键 = 逐字节回退今日行为。
    const _hardDeadlineOn = webFetchDeadline.isWebFetchHardDeadlineEnabled(process.env);
    const parentSignal = webFetchDeadline.resolveParentSignal(context, process.env);
    let _ac = null;
    let _deadlineTimer = null;
    let _deadlineFired = false;
    let _onParentAbort = null;
    if (_hardDeadlineOn) {
      _ac = new AbortController();
      const totalMs = webFetchDeadline.resolveTotalDeadlineMs(timeoutMs, FETCH_TIMEOUT_MS);
      _deadlineTimer = setTimeout(() => {
        _deadlineFired = true;
        try { _ac.abort(); } catch { /* ignore */ }
      }, totalMs);
      if (_deadlineTimer && typeof _deadlineTimer.unref === 'function') _deadlineTimer.unref();
      if (parentSignal) {
        if (parentSignal.aborted) { try { _ac.abort(); } catch { /* ignore */ } }
        else {
          _onParentAbort = () => { try { _ac.abort(); } catch { /* ignore */ } };
          try { parentSignal.addEventListener('abort', _onParentAbort, { once: true }); } catch { /* ignore */ }
        }
      }
    }
    const _fetchSignal = _ac ? _ac.signal : null;
    const _cleanupDeadline = () => {
      if (_deadlineTimer) { try { clearTimeout(_deadlineTimer); } catch { /* ignore */ } _deadlineTimer = null; }
      if (parentSignal && _onParentAbort) {
        try { parentSignal.removeEventListener('abort', _onParentAbort); } catch { /* ignore */ }
        _onParentAbort = null;
      }
    };

    // SSRF guard: reject http(s) URLs that point to — or DNS-resolve to —
    // private/local network targets before any socket is opened.
    try {
      await assertPublicHttpUrlResolved(url, 'WebFetch URL');
    } catch (err) {
      _cleanupDeadline();
      return { success: false, error: err.message };
    }

    try {
      const rawHtml = await this._fetch(url, timeoutMs, _fetchSignal);

      // Extract title
      const title = this._extractTitle(rawHtml);

      // Convert to structured markdown
      const { content: mdContent, sections } = this._htmlToMarkdown(rawHtml);

      // Truncate if needed
      const truncated = mdContent.length > MAX_CONTENT_SIZE;
      const finalContent = truncated
        ? mdContent.slice(0, MAX_CONTENT_SIZE) + '\n\n... [content truncated]'
        : mdContent;

      // Infer domain type
      let domainType = 'other';
      try {
        const hostname = new URL(url).hostname;
        for (const [domain, type] of Object.entries(_DOMAIN_TYPE_MAP)) {
          if (hostname.includes(domain)) { domainType = type; break; }
        }
      } catch {}

      const result = {
        success: true,
        url,
        title: title || null,
        domainType,
        content: finalContent,
        sections,
        contentLength: mdContent.length,
        truncated,
        prompt: userPrompt || null,
      };

      _cacheSet(url, result);
      return result;
    } catch (err) {
      // Abort(总墙钟耗尽 / ESC / 底层 AbortSignal)→ 诚实、可重试的结果,而非无意义的
      // "Fetch failed"。区分「超时给不出」与「用户主动中断」,让模型知道下一步怎么做。
      if (_hardDeadlineOn && webFetchDeadline.isAbortError(err)) {
        const totalMs = webFetchDeadline.resolveTotalDeadlineMs(timeoutMs, FETCH_TIMEOUT_MS);
        if (_deadlineFired && !(parentSignal && parentSignal.aborted)) {
          return {
            success: false,
            error: `Fetch timed out: ${url} 在 ${Math.round(totalMs / 1000)}s 内未完成(网络/网关缓慢),已放弃。`
              + `可稍后重试、换更快的源,或改用 web_search。`,
            timedOut: true,
            url,
          };
        }
        return {
          success: false,
          error: `Fetch cancelled: 抓取 ${url} 已被中断。这不是失败——如需继续可重新发起(必要时换更快的源)。`,
          cancelled: true,
          url,
        };
      }
      return { success: false, error: `Fetch failed: ${err.message}` };
    } finally {
      _cleanupDeadline();
    }
  }

  // ── Network fetch with proxy support ─────────────────────────────
  _fetch(url, timeoutMs = FETCH_TIMEOUT_MS, signal = null) {
    // Try proxy first
    const proxyUrl = this._getProxyUrl();
    if (proxyUrl) return this._fetchViaProxy(url, proxyUrl, timeoutMs, signal);
    return this._fetchDirect(url, timeoutMs, signal);
  }

  _getProxyUrl() {
    try {
      const pcs = require('../../services/proxyConfigService');
      const active = pcs.getActiveProxy ? pcs.getActiveProxy() : null;
      if (active) return active;
    } catch {}
    return process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy || null;
  }

  _fetchViaProxy(targetUrl, proxyUrl, timeoutMs = FETCH_TIMEOUT_MS, signal = null) {
    return new Promise((resolve, reject) => {
      const target = new URL(targetUrl);
      const proxy = new URL(proxyUrl);

      const connectReq = http.request(webFetchDeadline.mergeSignalOption({
        host: proxy.hostname,
        port: proxy.port || 7890,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` },
        timeout: timeoutMs,
      }, signal));

      connectReq.on('connect', (_res, socket) => {
        const options = webFetchDeadline.mergeSignalOption({
          hostname: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          socket,
          headers: {
            'User-Agent': 'khy-OS/1.0 (WebFetchTool)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
            Host: target.hostname,
          },
          timeout: timeoutMs,
        }, signal);

        const req = https.request(options, (res) => {
          this._handleResponse(res, targetUrl, resolve, reject, timeoutMs, signal);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
        req.end();
      });

      connectReq.on('error', () => {
        // Proxy failed, fall back to direct
        this._fetchDirect(targetUrl, timeoutMs, signal).then(resolve).catch(reject);
      });
      connectReq.on('timeout', () => {
        connectReq.destroy();
        this._fetchDirect(targetUrl, timeoutMs, signal).then(resolve).catch(reject);
      });
      connectReq.end();
    });
  }

  _fetchDirect(url, timeoutMs = FETCH_TIMEOUT_MS, signal = null) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(url, webFetchDeadline.mergeSignalOption({
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'khy-OS/1.0 (WebFetchTool)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        },
      }, signal), (res) => {
        this._handleResponse(res, url, resolve, reject, timeoutMs, signal);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  _handleResponse(res, url, resolve, reject, timeoutMs = FETCH_TIMEOUT_MS, signal = null) {
    // Handle redirects
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      const redirectUrl = res.headers.location;
      try {
        const redirectParsed = new URL(redirectUrl, url);
        const originalParsed = new URL(url);
        if (redirectParsed.hostname !== originalParsed.hostname) {
          resolve(`[Redirect to different host: ${redirectParsed.toString()}]\nPlease make a new WebFetch request with this URL.`);
          return;
        }
        // Re-validate the redirect target before following (guards a public
        // host that 3xx-redirects into the internal network, and DNS rebinding).
        // signal 沿重定向链传递:整条链共享同一个总墙钟 controller,重定向不再重置预算。
        assertPublicHttpUrlResolved(redirectParsed.toString(), 'WebFetch redirect')
          .then(() => this._fetchDirect(redirectParsed.toString(), timeoutMs, signal).then(resolve).catch(reject))
          .catch(reject);
      } catch {
        reject(new Error(`Invalid redirect URL: ${redirectUrl}`));
      }
      return;
    }

    if (res.statusCode >= 400) {
      reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      return;
    }

    const chunks = [];
    let totalSize = 0;
    res.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_CONTENT_SIZE * 2) { res.destroy(); return; }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(this._decodeBody(Buffer.concat(chunks), res.headers && res.headers['content-type'])));
    res.on('error', reject);
  }

  // ── 响应体解码(charset-aware;门控 KHY_WEBFETCH_CHARSET,默认开)──────────────────
  // 历史恒 `.toString('utf-8')` → GB2312/GBK 中文站乱码。开 → 用 webFetchDecode 按服务器声明的
  // charset(Content-Type header → <meta> 嗅探)解码,未知标签回退 utf-8。关 / 异常 → 逐字节
  // 回退 `.toString('utf-8')`。UTF-8 站点两路等价。
  _decodeBody(buffer, contentTypeHeader) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    let on = true;
    try {
      const reg = require('../../services/flagRegistry');
      if (reg && typeof reg.isFlagEnabled === 'function') {
        on = reg.isFlagEnabled('KHY_WEBFETCH_CHARSET', process.env);
      }
    } catch { on = true; }
    if (!on) return buf.toString('utf-8');
    try {
      const dec = require('../../services/webFetchDecode');
      const charset = dec.detectCharset(buf, contentTypeHeader || '');
      return dec.decodeBuffer(buf, charset);
    } catch {
      return buf.toString('utf-8');
    }
  }

  // ── Title extraction ─────────────────────────────────────────────
  _extractTitle(html) {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!m) return '';
    return this._decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  }

  // ── Structured HTML → Markdown conversion ────────────────────────
  _htmlToMarkdown(html) {
    if (!html) return { content: '', sections: [] };

    let text = html;

    // Phase 1: Remove noise blocks
    const noisePatterns = [
      /<script[\s\S]*?<\/script>/gi,
      /<style[\s\S]*?<\/style>/gi,
      /<noscript[\s\S]*?<\/noscript>/gi,
      /<svg[\s\S]*?<\/svg>/gi,
      /<iframe[\s\S]*?<\/iframe>/gi,
      /<!--[\s\S]*?-->/g,
    ];
    for (const pat of noisePatterns) text = text.replace(pat, '');

    // Phase 2: Extract main content area if available
    const mainMatch = text.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    if (mainMatch && mainMatch[1].length > 200) {
      text = mainMatch[1];
    } else {
      // Remove nav/footer/aside/header for cleaner content
      text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
      text = text.replace(/<aside[\s\S]*?<\/aside>/gi, '');
      text = text.replace(/<header[\s\S]*?<\/header>/gi, '\n');
    }

    // Remove everything before <body> if present
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*)/i);
    if (bodyMatch) text = bodyMatch[1].replace(/<\/body>[\s\S]*$/i, '');

    // Phase 3: Structural conversions (order matters)

    // Code blocks: <pre><code> → fenced blocks
    text = text.replace(/<pre[^>]*>\s*<code[^>]*(?:\s+class="[^"]*?(?:language-)?(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_, lang, code) => `\n\`\`\`${lang || ''}\n${this._decodeEntities(code.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`);
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi,
      (_, code) => `\n\`\`\`\n${this._decodeEntities(code.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`);

    // Inline code
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${this._decodeEntities(code.replace(/<[^>]+>/g, ''))}\``);

    // Headings
    text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${this._stripInnerTags(t)}\n\n`);
    text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${this._stripInnerTags(t)}\n\n`);
    text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n\n### ${this._stripInnerTags(t)}\n\n`);
    text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n\n#### ${this._stripInnerTags(t)}\n\n`);
    text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n\n##### ${this._stripInnerTags(t)}\n\n`);
    text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n\n###### ${this._stripInnerTags(t)}\n\n`);

    // Links: preserve href
    text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, linkText) => {
        const clean = this._stripInnerTags(linkText).trim();
        if (!clean || !href || href.startsWith('#') || href.startsWith('javascript:')) return clean;
        return `[${clean}](${href})`;
      });

    // Images
    text = text.replace(/<img[^>]+alt="([^"]*)"[^>]*>/gi, (_, alt) => alt ? `[Image: ${alt}]` : '');
    text = text.replace(/<img[^>]*>/gi, '');

    // Blockquotes
    text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, content) => '\n' + this._stripInnerTags(content).split('\n').map(l => `> ${l.trim()}`).join('\n') + '\n');

    // Lists
    text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => `\n- ${this._stripInnerTags(item).trim()}`);
    text = text.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n');

    // Tables: simple conversion
    text = text.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
      return this._tableToMarkdown(tableHtml);
    });

    // Bold/italic
    text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, t) => `**${this._stripInnerTags(t)}**`);
    text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, t) => `*${this._stripInnerTags(t)}*`);

    // Block elements → newlines
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(?:p|div|section|article|main)[^>]*>/gi, '\n\n');
    text = text.replace(/<(?:p|div|section)[^>]*>/gi, '\n');
    text = text.replace(/<hr[^>]*>/gi, '\n---\n');

    // Phase 4: Decode entities
    text = this._decodeEntities(text);

    // Phase 5: Strip remaining tags
    text = text.replace(/<[^>]+>/g, '');

    // Phase 6: Clean whitespace
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{4,}/g, '\n\n\n');
    text = text.replace(/^\s+/gm, (match) => {
      // Preserve indentation for code-like content, collapse others
      return match.length > 4 ? '    ' : '';
    });
    text = text.trim();

    // Phase 7: Extract sections for metadata
    const sections = [];
    const headingRe = /^(#{1,6})\s+(.+)$/gm;
    let hMatch;
    while ((hMatch = headingRe.exec(text)) !== null) {
      sections.push({ heading: hMatch[2].trim(), level: hMatch[1].length });
    }

    // Phase 8: Prepend table of contents if 3+ sections
    if (sections.length >= 3) {
      const toc = sections.slice(0, 15).map(s => {
        const indent = '  '.repeat(Math.max(0, s.level - 1));
        return `${indent}- ${s.heading}`;
      }).join('\n');
      text = `## Page Structure\n${toc}\n\n---\n\n${text}`;
    }

    return { content: text, sections };
  }

  // ── Helpers ───────────────────────────────────────────────────────
  _stripInnerTags(html) {
    return this._decodeEntities((html || '').replace(/<[^>]+>/g, '')).trim();
  }

  _decodeEntities(text) {
    if (!text) return '';
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }

  _tableToMarkdown(tableHtml) {
    const rows = [];
    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi);
    if (!rowMatches || rowMatches.length === 0) return '';

    for (const rowHtml of rowMatches) {
      const cells = [];
      const cellMatches = rowHtml.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi);
      if (cellMatches) {
        for (const cellHtml of cellMatches) {
          const content = cellHtml.replace(/<\/?(?:td|th)[^>]*>/gi, '');
          cells.push(this._stripInnerTags(content).replace(/\|/g, '\\|'));
        }
      }
      if (cells.length > 0) rows.push(cells);
    }

    if (rows.length === 0) return '';

    // Build markdown table
    const maxCols = Math.max(...rows.map(r => r.length));
    const lines = [];
    for (let i = 0; i < rows.length; i++) {
      const padded = rows[i].concat(Array(maxCols - rows[i].length).fill(''));
      lines.push('| ' + padded.join(' | ') + ' |');
      // Add separator after first row (header)
      if (i === 0) {
        lines.push('| ' + padded.map(() => '---').join(' | ') + ' |');
      }
    }
    return '\n' + lines.join('\n') + '\n';
  }
}

module.exports = new WebFetchTool();
module.exports.WebFetchTool = WebFetchTool;
