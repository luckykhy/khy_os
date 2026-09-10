'use strict';

/**
 * Rerank service — re-rank documents by relevance to a query.
 * Supports multiple providers: Cohere, Together AI, Voyage.
 */

const https = require('https');
const { URL } = require('url');

function _env(name, prefix = 'KHY_RERANK') {
  return String(process.env[`${prefix}_${name}`] || '').trim();
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
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
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

// ── Cohere Rerank ──
async function cohereRerank(query, documents, options = {}) {
  const apiKey = _env('COHERE_API_KEY');
  if (!apiKey) return { error: 'Cohere API Key not configured. Set KHY_RERANK_COHERE_API_KEY.' };

  const model = options.model || 'rerank-english-v3.0';
  const result = await _request('https://api.cohere.com/v1/rerank', 'POST', {
    model,
    query,
    documents: documents.map((d) => typeof d === 'string' ? d : d.text),
    top_n: options.topN || documents.length,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `Cohere rerank error: ${result.status}`, data: result.data };

  return {
    success: true,
    rankings: result.data.results.map((r) => ({
      index: r.index,
      score: r.relevance_score,
      document: documents[r.index],
    })),
    model,
    provider: 'cohere',
  };
}

// ── Together AI Rerank ──
async function togetherRerank(query, documents, options = {}) {
  const apiKey = _env('TOGETHER_API_KEY');
  if (!apiKey) return { error: 'Together AI API Key not configured. Set KHY_RERANK_TOGETHER_API_KEY.' };

  const model = options.model || 'togethercomputer/m2-bert-80M-8k-retrieval';
  const result = await _request('https://api.together.xyz/v1/rerank', 'POST', {
    model,
    query,
    documents: documents.map((d) => typeof d === 'string' ? d : d.text),
    top_n: options.topN || documents.length,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `Together rerank error: ${result.status}`, data: result.data };

  return {
    success: true,
    rankings: result.data.results?.map((r) => ({
      index: r.index,
      score: r.relevance_score,
      document: documents[r.index],
    })) || [],
    model,
    provider: 'together',
  };
}

// ── Voyage Rerank ──
async function voyageRerank(query, documents, options = {}) {
  const apiKey = _env('VOYAGE_API_KEY');
  if (!apiKey) return { error: 'Voyage API Key not configured. Set KHY_RERANK_VOYAGE_API_KEY.' };

  const model = options.model || 'rerank-2-lite';
  const result = await _request('https://api.voyageai.com/v1/rerank', 'POST', {
    model,
    query,
    documents: documents.map((d) => typeof d === 'string' ? d : d.text),
    top_n: options.topN || documents.length,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `Voyage rerank error: ${result.status}`, data: result.data };

  return {
    success: true,
    rankings: result.data.data?.map((r) => ({
      index: r.index,
      score: r.relevance_score,
      document: documents[r.index],
    })) || [],
    model,
    provider: 'voyage',
  };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'cohere', name: 'Cohere Rerank', fn: cohereRerank },
  { id: 'together', name: 'Together AI', fn: togetherRerank },
  { id: 'voyage', name: 'Voyage AI', fn: voyageRerank },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'cohere': return !!_env('COHERE_API_KEY');
    case 'together': return !!_env('TOGETHER_API_KEY');
    case 'voyage': return !!_env('VOYAGE_API_KEY');
    default: return false;
  }
}

async function rerank(providerId, query, documents, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}. Available: ${PROVIDERS.map((p) => p.id).join(', ')}` };
  return provider.fn(query, documents, options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  rerank,
  cohereRerank,
  togetherRerank,
  voyageRerank,
};
