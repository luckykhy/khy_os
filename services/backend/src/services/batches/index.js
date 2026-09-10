'use strict';

/**
 * Batch API service — batch processing for completions, embeddings, etc.
 * Supports OpenAI Batch API.
 */

const https = require('https');
const fs = require('fs');

function _env(name) {
  return String(process.env[`KHY_BATCH_${name}`] || '').trim();
}

function _request(urlStr, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(require('url').URL);
      const data = body ? JSON.stringify(body) : '';
      const req = https.request({
        hostname: new URL(urlStr).hostname,
        path: new URL(urlStr).pathname + new URL(urlStr).search,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0, ...headers },
      }, (res) => {
        let responseData = '';
        res.on('data', (c) => { responseData += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
          catch { resolve({ status: res.statusCode, data: responseData }); }
        });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.setTimeout(60000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── OpenAI Batch API ──
async function openaiCreateBatch(inputFileId, endpoint = '/v1/chat/completions', window = '24h') {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request('https://api.openai.com/v1/batches', 'POST', {
    input_file_id: inputFileId,
    endpoint,
    completion_window: window,
    metadata: { source: 'khy-os' },
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `OpenAI Batch error: ${result.status}`, data: result.data };
  return { success: true, batch: result.data, provider: 'openai' };
}

async function openaiListBatches(limit = 10) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/batches?limit=${limit}`, 'GET', null, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) return { error: `OpenAI Batch error: ${result.status}` };
  return { success: true, batches: result.data.data, provider: 'openai' };
}

async function openaiGetBatch(batchId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/batches/${batchId}`, 'GET', null, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) return { error: `OpenAI Batch error: ${result.status}` };
  return { success: true, batch: result.data, provider: 'openai' };
}

async function openaiCancelBatch(batchId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/batches/${batchId}/cancel`, 'POST', {}, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) return { error: `OpenAI Batch error: ${result.status}` };
  return { success: true, batch: result.data, provider: 'openai' };
}

async function openaiCreateInputFile(jsonlContent) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nbatch\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="batch.jsonl"\r\nContent-Type: application/jsonl\r\n\r\n`),
    Buffer.from(jsonlContent),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/files',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(responseBody) }); }
        catch { resolve({ status: res.statusCode, error: responseBody }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(body);
    req.end();
  });
}

// ── Provider registry ──
const PROVIDERS = {
  openai: {
    name: 'OpenAI Batch',
    createBatch: openaiCreateBatch,
    listBatches: openaiListBatches,
    getBatch: openaiGetBatch,
    cancelBatch: openaiCancelBatch,
    createInputFile: openaiCreateInputFile,
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'openai': return !!(_env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    default: return false;
  }
}

module.exports = {
  listProviders,
  isProviderConfigured,
  openaiCreateBatch,
  openaiListBatches,
  openaiGetBatch,
  openaiCancelBatch,
  openaiCreateInputFile,
  PROVIDERS,
};
