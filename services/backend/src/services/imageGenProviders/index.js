'use strict';

/**
 * Image Generation Provider Extensions
 * Adds support for Flux, Stable Diffusion API, and other providers
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

function _env(name, prefix = 'KHY_IMAGE_GEN') {
  return String(process.env[`${prefix}_${name}`] || '').trim();
}

function _request(urlStr, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
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
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Flux (via Replicate or direct) ──
async function fluxGenerate(prompt, options = {}) {
  const apiKey = _env('FLUX_API_KEY') || _env('REPLICATE_API_TOKEN');
  if (!apiKey) return { error: 'Flux API Key not configured. Set KHY_IMAGE_GEN_FLUX_API_KEY.' };

  const model = options.model || 'flux-schnell';
  const endpoint = options.endpoint || 'https://api.replicate.com/v1/predictions';
  const body = {
    input: {
      prompt,
      num_outputs: options.numOutputs || 1,
      aspect_ratio: options.aspectRatio || '1:1',
    },
  };
  if (model.startsWith('black-forest-labs/')) {
    body.version = model;
  } else {
    body.model = model;
  }

  const result = await _request(endpoint, 'POST', body, { 'Authorization': `Bearer ${apiKey}` });
  if (result.status !== 201 && result.status !== 200) {
    return { error: `Flux API error: ${result.status}`, data: result.data };
  }
  return { success: true, prediction: result.data };
}

// ── Stable Diffusion API ──
async function sdGenerate(prompt, options = {}) {
  const apiKey = _env('SD_API_KEY');
  const endpoint = options.endpoint || _env('SD_BASE_URL') || 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image';

  if (!apiKey) return { error: 'SD API Key not configured. Set KHY_IMAGE_GEN_SD_API_KEY.' };

  const body = {
    text_prompts: [{ text: prompt, weight: 1 }],
    cfg_scale: options.cfgScale || 7,
    height: options.height || 1024,
    width: options.width || 1024,
    steps: options.steps || 30,
    samples: options.samples || 1,
  };

  const result = await _request(endpoint, 'POST', body, {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  });

  if (result.status !== 200) {
    return { error: `SD API error: ${result.status}`, data: result.data };
  }

  return {
    success: true,
    images: (result.data.artifacts || []).map((a) => ({ base64: a.base64, seed: a.seed })),
  };
}

// ── Gemini Imagen ──
async function geminiImagenGenerate(prompt, options = {}) {
  const apiKey = _env('GEMINI_API_KEY');
  if (!apiKey) return { error: 'Gemini API Key not configured. Set KHY_IMAGE_GEN_GEMINI_API_KEY.' };

  const model = options.model || 'imagen-3.0-generate-002';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

  const body = {
    instances: [{ prompt }],
    parameters: { sampleCount: options.sampleCount || 1 },
  };

  const result = await _request(endpoint, 'POST', body);
  if (result.status !== 200) {
    return { error: `Gemini Imagen error: ${result.status}`, data: result.data };
  }

  return {
    success: true,
    images: (result.data.predictions || []).map((p) => ({ base64: p.bytesBase64Encoded })),
  };
}

// ── OpenAI DALL-E 3 ──
async function dalleGenerate(prompt, options = {}) {
  const apiKey = _env('OPENAI_API_KEY');
  if (!apiKey) return { error: 'OpenAI API Key not configured. Set OPENAI_API_KEY.' };

  const body = {
    model: options.model || 'dall-e-3',
    prompt,
    n: options.n || 1,
    size: options.size || '1024x1024',
    quality: options.quality || 'standard',
  };

  const result = await _request('https://api.openai.com/v1/images/generations', 'POST', body, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) {
    return { error: `DALL-E error: ${result.status}`, data: result.data };
  }

  return { success: true, images: result.data.data };
}

// ── Provider registry ──
const PROVIDERS = {
  flux: { name: 'Flux', generate: fluxGenerate },
  stable_diffusion: { name: 'Stable Diffusion', generate: sdGenerate },
  gemini_imagen: { name: 'Gemini Imagen', generate: geminiImagenGenerate },
  dalle: { name: 'DALL-E', generate: dalleGenerate },
};

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }));
}

async function generateImage(providerId, prompt, options = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { error: `Unknown provider: ${providerId}. Available: ${Object.keys(PROVIDERS).join(', ')}` };
  }
  return provider.generate(prompt, options);
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'flux': return !!(_env('FLUX_API_KEY') || _env('REPLICATE_API_TOKEN'));
    case 'stable_diffusion': return !!_env('SD_API_KEY');
    case 'gemini_imagen': return !!_env('GEMINI_API_KEY');
    case 'dalle': return !!_env('OPENAI_API_KEY');
    default: return false;
  }
}

module.exports = {
  listProviders,
  generateImage,
  isProviderConfigured,
  PROVIDERS,
};
