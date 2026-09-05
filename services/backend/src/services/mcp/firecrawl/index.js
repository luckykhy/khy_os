'use strict';

/**
 * Firecrawl built-in MCP service.
 *
 * Provides web search and URL scraping capabilities.
 * API Key from env: KHY_FIRECRAWL_API_KEY
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_BASE_URL = 'https://api.firecrawl.dev';
const DEFAULT_TIMEOUT_MS = 60000;

function _env(name) {
  return String(process.env[`KHY_FIRECRAWL_${name}`] || '').trim();
}

function _apiKey() {
  return _env('API_KEY') || process.env.FIRECRAWL_API_KEY || '';
}

function _baseUrl() {
  return _env('BASE_URL') || DEFAULT_BASE_URL;
}

function _timeoutMs() {
  const raw = parseInt(_env('TIMEOUT_MS'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function _request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, _baseUrl());
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${_apiKey()}`,
        'Content-Type': 'application/json',
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(_timeoutMs(), () => {
      req.destroy(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function search(query, options = {}) {
  const apiKey = _apiKey();
  if (!apiKey) {
    return { error: 'Firecrawl API Key not configured. Set KHY_FIRECRAWL_API_KEY.' };
  }

  const limit = options.limit || 5;
  const path = `/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`;

  const result = await _request(path);
  if (result.status !== 200) {
    return { error: `Firecrawl search failed: ${result.status}`, data: result.data };
  }

  return {
    success: true,
    results: (result.data?.data || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
    })),
  };
}

async function scrapeUrl(url) {
  const apiKey = _apiKey();
  if (!apiKey) {
    return { error: 'Firecrawl API Key not configured. Set KHY_FIRECRAWL_API_KEY.' };
  }

  const path = '/v1/scrape';
  const body = { url, formats: ['markdown'] };

  const result = await _request(path, 'POST', body);
  if (result.status !== 200) {
    return { error: `Firecrawl scrape failed: ${result.status}`, data: result.data };
  }

  return {
    success: true,
    content: result.data?.data?.markdown || '',
    url,
  };
}

module.exports = {
  search,
  scrapeUrl,
  isConfigured: () => !!_apiKey(),
};
