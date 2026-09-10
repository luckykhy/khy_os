'use strict';

/**
 * Search Provider Extensions
 * Adds support for multiple search APIs.
 */

const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_SEARCH_${name}`] || '').trim();
}

function _request(urlStr, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const data = body ? JSON.stringify(body) : '';
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      }, (res) => {
        let responseData = '';
        res.on('data', (c) => { responseData += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
          catch { resolve({ status: res.statusCode, data: responseData }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── Serper ──
async function serperSearch(query, options = {}) {
  const apiKey = _env('SERPER_API_KEY');
  if (!apiKey) return { error: 'Serper API Key not configured. Set KHY_SEARCH_SERPER_API_KEY.' };

  const result = await _request('https://google.serper.dev/search', 'POST', {
    q: query,
    num: options.limit || 10,
  }, { 'X-API-KEY': apiKey });

  if (result.status !== 200) return { error: `Serper error: ${result.status}` };

  return {
    success: true,
    results: (result.data.organic || []).map((r) => ({
      title: r.title,
      snippet: r.snippet,
      url: r.link,
    })),
    provider: 'serper',
  };
}

// ── Tavily ──
async function tavilySearch(query, options = {}) {
  const apiKey = _env('TAVILY_API_KEY');
  if (!apiKey) return { error: 'Tavily API Key not configured. Set KHY_SEARCH_TAVILY_API_KEY.' };

  const result = await _request('https://api.tavily.com/search', 'POST', {
    query,
    max_results: options.limit || 5,
    search_depth: 'basic',
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `Tavily error: ${result.status}` };

  return {
    success: true,
    results: (result.data.results || []).map((r) => ({
      title: r.title,
      snippet: r.content,
      url: r.url,
      score: r.score,
    })),
    provider: 'tavily',
  };
}

// ── You.com ──
async function youSearch(query, options = {}) {
  const apiKey = _env('YOU_API_KEY');
  if (!apiKey) return { error: 'You.com API Key not configured. Set KHY_SEARCH_YOU_API_KEY.' };

  const result = await _request(`https://api.ydc-index.io/search?query=${encodeURIComponent(query)}`, 'GET', null, {
    'X-API-Key': apiKey,
  });

  if (result.status !== 200) return { error: `You.com error: ${result.status}` };

  return {
    success: true,
    results: (result.data.hits || []).map((h) => ({
      title: h.title,
      snippet: h.description,
      url: h.url,
    })),
    provider: 'you',
  };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'serper', name: 'Serper (Google)', search: serperSearch },
  { id: 'tavily', name: 'Tavily', search: tavilySearch },
  { id: 'you', name: 'You.com', search: youSearch },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'serper': return !!_env('SERPER_API_KEY');
    case 'tavily': return !!_env('TAVILY_API_KEY');
    case 'you': return !!_env('YOU_API_KEY');
    default: return false;
  }
}

async function search(providerId, query, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.search(query, options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  search,
  serperSearch,
  tavilySearch,
  youSearch,
};
