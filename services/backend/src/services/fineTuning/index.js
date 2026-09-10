'use strict';

/**
 * Fine-tuning service — managed model fine-tuning.
 * Supports multiple providers: OpenAI, Azure, Vertex AI.
 */

const fs = require('fs');
const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_FINETUNE_${name}`] || '').trim();
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
      req.setTimeout(60000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── OpenAI Fine-tuning ──
async function openaiCreateJob(trainingFileId, options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request('https://api.openai.com/v1/fine_tuning/jobs', 'POST', {
    training_file: trainingFileId,
    model: options.model || 'gpt-4o-mini-2024-07-18',
    hyperparameters: options.hyperparameters || { n_epochs: 'auto' },
    suffix: options.suffix || null,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `OpenAI fine-tuning error: ${result.status}`, data: result.data };
  return { success: true, job: result.data, provider: 'openai' };
}

async function openaiListJobs(limit = 10) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  return _request(`https://api.openai.com/v1/fine_tuning/jobs?limit=${limit}`, 'GET', null, {
    'Authorization': `Bearer ${apiKey}`,
  });
}

async function openaiGetJob(jobId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  return _request(`https://api.openai.com/v1/fine_tuning/jobs/${jobId}`, 'GET', null, {
    'Authorization': `Bearer ${apiKey}`,
  });
}

async function openaiCancelJob(jobId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  return _request(`https://api.openai.com/v1/fine_tuning/jobs/${jobId}/cancel`, 'POST', {}, {
    'Authorization': `Bearer ${apiKey}`,
  });
}

// ── Azure Fine-tuning ──
async function azureCreateJob(trainingFileId, options = {}) {
  const apiKey = _env('AZURE_OPENAI_API_KEY');
  const endpoint = _env('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) return { error: 'Azure OpenAI API Key not configured.' };

  const result = await _request(`${endpoint}/openai/fine_tuning/jobs?api-version=2024-02-15-preview`, 'POST', {
    model: options.model || 'gpt-4o-mini',
    training_file: trainingFileId,
  }, { 'api-key': apiKey });

  if (result.status !== 201) return { error: `Azure fine-tuning error: ${result.status}` };
  return { success: true, job: result.data, provider: 'azure' };
}

// ── Vertex AI Fine-tuning ──
async function vertexCreateJob(trainingData, options = {}) {
  const apiKey = _env('VERTEX_API_KEY') || process.env.GOOGLE_API_KEY;
  const project = _env('VERTEX_PROJECT');
  const location = _env('VERTEX_LOCATION') || 'us-central1';

  if (!apiKey) return { error: 'Vertex API Key not configured.' };

  const result = await _request(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/tuningJobs`,
    'POST',
    {
      baseModel: options.baseModel || 'gemini-1.5-flash',
      trainingData,
    },
    { 'Authorization': `Bearer ${apiKey}` }
  );

  if (result.status !== 200) return { error: `Vertex fine-tuning error: ${result.status}` };
  return { success: true, job: result.data, provider: 'vertex' };
}

// ── Provider registry ──
const PROVIDERS = {
  openai: {
    name: 'OpenAI Fine-tuning',
    createJob: openaiCreateJob,
    listJobs: openaiListJobs,
    getJob: openaiGetJob,
    cancelJob: openaiCancelJob,
  },
  azure: {
    name: 'Azure Fine-tuning',
    createJob: azureCreateJob,
    listJobs: () => ({ error: 'Not implemented' }),
    getJob: () => ({ error: 'Not implemented' }),
    cancelJob: () => ({ error: 'Not implemented' }),
  },
  vertex: {
    name: 'Vertex AI Fine-tuning',
    createJob: vertexCreateJob,
    listJobs: () => ({ error: 'Not implemented' }),
    getJob: () => ({ error: 'Not implemented' }),
    cancelJob: () => ({ error: 'Not implemented' }),
  },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'openai': return !!(_env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    case 'azure': return !!_env('AZURE_OPENAI_API_KEY');
    case 'vertex': return !!(_env('VERTEX_API_KEY') || process.env.GOOGLE_API_KEY);
    default: return false;
  }
}

async function createJob(providerId, ...args) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.createJob(...args);
}

async function listJobs(providerId, ...args) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.listJobs(...args);
}

async function getJob(providerId, ...args) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.getJob(...args);
}

async function cancelJob(providerId, ...args) {
  const provider = PROVIDERS[providerId];
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.cancelJob(...args);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  createJob,
  listJobs,
  getJob,
  cancelJob,
  openaiCreateJob,
  openaiListJobs,
  openaiGetJob,
  openaiCancelJob,
};
