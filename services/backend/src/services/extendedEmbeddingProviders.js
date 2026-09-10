'use strict';

/**
 * Extended Embedding Providers — adds support for multiple embedding APIs.
 * Separate from embeddingClient.js to preserve its SSOT design.
 */

const https = require('https');
const { URL } = require('url');

function _extEnv(name) {
  return String(process.env[`KHY_EMBED_${name}`] || '').trim();
}

function _request(urlStr, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── OpenAI Embedding ──
async function openaiEmbed(texts, options = {}) {
  const apiKey = _extEnv('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured. Set KHY_EMBED_OPENAI_API_KEY or OPENAI_API_KEY.' };
  const model = options.model || 'text-embedding-3-small';
  const result = await _request('https://api.openai.com/v1/embeddings', 'POST', { input: texts, model }, { 'Authorization': `Bearer ${apiKey}` });
  if (result.status !== 200) return { error: `OpenAI error: ${result.status}`, data: result.data };
  return { success: true, embeddings: result.data.data.map((d) => d.embedding), model, provider: 'openai' };
}

// ── Voyage AI Embedding ──
async function voyageEmbed(texts, options = {}) {
  const apiKey = _extEnv('VOYAGE_API_KEY');
  if (!apiKey) return { error: 'Voyage API Key not configured. Set KHY_EMBED_VOYAGE_API_KEY.' };
  const model = options.model || 'voyage-3-lite';
  const result = await _request('https://api.voyageai.com/v1/embeddings', 'POST', { input: texts, model }, { 'Authorization': `Bearer ${apiKey}` });
  if (result.status !== 200) return { error: `Voyage error: ${result.status}` };
  return { success: true, embeddings: result.data.data.map((d) => d.embedding), model, provider: 'voyage' };
}

// ── Jina AI Embedding ──
async function jinaEmbed(texts, options = {}) {
  const apiKey = _extEnv('JINA_API_KEY');
  if (!apiKey) return { error: 'Jina API Key not configured. Set KHY_EMBED_JINA_API_KEY.' };
  const model = options.model || 'jina-embeddings-v3';
  const result = await _request('https://api.jina.ai/v1/embeddings', 'POST', { input: texts, model }, { 'Authorization': `Bearer ${apiKey}` });
  if (result.status !== 200) return { error: `Jina error: ${result.status}` };
  return { success: true, embeddings: result.data.data.map((d) => d.embedding), model, provider: 'jina' };
}

// ── Cohere Embedding ──
async function cohereEmbed(texts, options = {}) {
  const apiKey = _extEnv('COHERE_API_KEY');
  if (!apiKey) return { error: 'Cohere API Key not configured. Set KHY_EMBED_COHERE_API_KEY.' };
  const model = options.model || 'embed-english-v3.0';
  const result = await _request('https://api.cohere.com/v1/embed', 'POST', { texts, model, input_type: 'search_document' }, { 'Authorization': `Bearer ${apiKey}` });
  if (result.status !== 200) return { error: `Cohere error: ${result.status}` };
  return { success: true, embeddings: result.data.embeddings, model, provider: 'cohere' };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI Embedding', fn: openaiEmbed },
  { id: 'voyage', name: 'Voyage AI', fn: voyageEmbed },
  { id: 'jina', name: 'Jina AI', fn: jinaEmbed },
  { id: 'cohere', name: 'Cohere', fn: cohereEmbed },
];

function listExtendedProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isExtendedProviderConfigured(providerId) {
  switch (providerId) {
    case 'openai': return !!(_extEnv('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    case 'voyage': return !!_extEnv('VOYAGE_API_KEY');
    case 'jina': return !!_extEnv('JINA_API_KEY');
    case 'cohere': return !!_extEnv('COHERE_API_KEY');
    default: return false;
  }
}

async function embedWithProvider(providerId, texts, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.fn(texts, options);
}

module.exports = {
  listExtendedProviders,
  isExtendedProviderConfigured,
  embedWithProvider,
  openaiEmbed,
  voyageEmbed,
  jinaEmbed,
  cohereEmbed,
};
