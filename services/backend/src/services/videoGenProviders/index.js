'use strict';

/**
 * Video Generation Provider Extensions
 * Adds support for multiple video generation APIs.
 */

const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_VIDEO_GEN_${name}`] || '').trim();
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
      req.setTimeout(120000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── RunwayML Gen-3 ──
async function runwayGenerate(prompt, options = {}) {
  const apiKey = _env('RUNWAY_API_KEY');
  if (!apiKey) return { error: 'Runway API Key not configured. Set KHY_VIDEO_GEN_RUNWAY_API_KEY.' };

  const result = await _request('https://api.runwayml.com/v1/video/generate', 'POST', {
    prompt,
    model: options.model || 'gen3a_turbo',
    duration: options.duration || 5,
    aspect_ratio: options.aspectRatio || '16:9',
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200 && result.status !== 201) {
    return { error: `Runway error: ${result.status}`, data: result.data };
  }
  return { success: true, taskId: result.data.task_id || result.data.id, provider: 'runway' };
}

// ── OpenAI Sora ──
async function soraGenerate(prompt, options = {}) {
  const apiKey = _env('OPENAI_API_KEY');
  if (!apiKey) return { error: 'OpenAI API Key not configured for Sora.' };

  const result = await _request('https://api.openai.com/v1/videos', 'POST', {
    prompt,
    model: options.model || 'sora',
    seconds: options.seconds || '5',
    size: options.size || '1280x720',
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) {
    return { error: `Sora error: ${result.status}` };
  }
  return { success: true, taskId: result.data.id, provider: 'sora' };
}

// ── Kling AI ──
async function klingGenerate(prompt, options = {}) {
  const apiKey = _env('KLING_API_KEY');
  if (!apiKey) return { error: 'Kling API Key not configured. Set KHY_VIDEO_GEN_KLING_API_KEY.' };

  const result = await _request('https://api.klingai.com/v1/videos/text2video', 'POST', {
    prompt,
    model: options.model || 'kling-v1',
    duration: options.duration || '5',
    mode: options.mode || 'std',
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) {
    return { error: `Kling error: ${result.status}` };
  }
  return { success: true, taskId: result.data.task_id, provider: 'kling' };
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'runway', name: 'RunwayML Gen-3', generate: runwayGenerate },
  { id: 'sora', name: 'OpenAI Sora', generate: soraGenerate },
  { id: 'kling', name: 'Kling AI', generate: klingGenerate },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'runway': return !!_env('RUNWAY_API_KEY');
    case 'sora': return !!_env('OPENAI_API_KEY');
    case 'kling': return !!_env('KLING_API_KEY');
    default: return false;
  }
}

async function generateVideo(providerId, prompt, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.generate(prompt, options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  generateVideo,
  PROVIDERS,
};
