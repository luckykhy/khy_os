'use strict';

/**
 * OCR Provider Extensions
 * Adds support for multiple OCR APIs.
 */

const https = require('https');
const fs = require('fs');

function _env(name) {
  return String(process.env[`KHY_OCR_${name}`] || '').trim();
}

function _request(urlStr, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve) => {
    try {
      const { URL } = require('url');
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

// ── Azure AI Vision OCR ──
async function azureOCR(imageBase64, options = {}) {
  const apiKey = _env('AZURE_VISION_API_KEY');
  const endpoint = _env('AZURE_VISION_ENDPOINT') || 'https://api.cognitive.microsoft.com';
  if (!apiKey) return { error: 'Azure Vision API Key not configured. Set KHY_OCR_AZURE_VISION_API_KEY.' };

  return new Promise((resolve) => {
    const req = https.request({
      hostname: new URL(endpoint).hostname,
      path: '/vision/v3.2/ocr',
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/octet-stream',
        'Content-Length': Buffer.byteLength(Buffer.from(imageBase64, 'base64')),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode === 200) {
            const text = (json.regions || []).flatMap((r) =>
              (r.lines || []).flatMap((l) =>
                (l.words || []).map((w) => w.text).join(' ')
              )
            ).join('\n');
            resolve({ success: true, text, provider: 'azure' });
          } else {
            resolve({ error: `Azure OCR error: ${res.statusCode}` });
          }
        } catch (e) { resolve({ error: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(Buffer.from(imageBase64, 'base64'));
    req.end();
  });
}

// ── Mistral OCR ──
async function mistralOCR(imageBase64, options = {}) {
  const apiKey = _env('MISTRAL_API_KEY');
  if (!apiKey) return { error: 'Mistral API Key not configured. Set KHY_OCR_MISTRAL_API_KEY.' };

  const result = await _request('https://api.mistral.ai/v1/ocr', 'POST', {
    model: 'mistral-ocr-latest',
    image_url: `data:image/png;base64,${imageBase64}`,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `Mistral OCR error: ${result.status}` };

  return {
    success: true,
    text: result.data.pages?.[0]?.markdown || result.data.text || '',
    provider: 'mistral',
  };
}

// ── Vertex AI OCR ──
async function vertexOCR(imageBase64, options = {}) {
  const apiKey = _env('VERTEX_API_KEY') || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { error: 'Vertex API Key not configured. Set KHY_OCR_VERTEX_API_KEY.' };

  const result = await _request(
    `https://us-aiplatform.googleapis.com/v1/projects/${_env('VERTEX_PROJECT')}/locations/us-central1/publishers/google/models/imagetext:predict`,
    'POST',
    { instances: [{ content: imageBase64 }] },
    { 'Authorization': `Bearer ${apiKey}` }
  );

  if (result.status !== 200) return { error: `Vertex OCR error: ${result.status}` };

  return {
    success: true,
    text: result.data.predictions?.[0]?.text || '',
    provider: 'vertex',
  };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'azure', name: 'Azure AI Vision', ocr: azureOCR },
  { id: 'mistral', name: 'Mistral OCR', ocr: mistralOCR },
  { id: 'vertex', name: 'Vertex AI', ocr: vertexOCR },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'azure': return !!_env('AZURE_VISION_API_KEY');
    case 'mistral': return !!_env('MISTRAL_API_KEY');
    case 'vertex': return !!(_env('VERTEX_API_KEY') || process.env.GOOGLE_API_KEY);
    default: return false;
  }
}

async function recognize(providerId, imageBase64, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.ocr(imageBase64, options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  recognize,
  azureOCR,
  mistralOCR,
  vertexOCR,
};
