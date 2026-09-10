'use strict';

/**
 * Text-to-Speech (TTS) Provider Extensions
 * Adds support for multiple TTS APIs beyond system-level TTS.
 */

const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_TTS_${name}`] || '').trim();
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

// ── OpenAI TTS ──
async function openaiTTS(text, options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const model = options.model || 'tts-1';
  const voice = options.voice || 'alloy';
  const endpoint = 'https://api.openai.com/v1/audio/speech';

  return new Promise((resolve) => {
    const data = JSON.stringify({ model, input: text, voice, response_format: options.format || 'mp3' });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, audio: Buffer.concat(chunks), format: options.format || 'mp3', provider: 'openai' });
        } else {
          resolve({ error: `OpenAI TTS error: ${res.statusCode}` });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(data);
    req.end();
  });
}

// ── ElevenLabs TTS ──
async function elevenlabsTTS(text, options = {}) {
  const apiKey = _env('ELEVENLABS_API_KEY');
  if (!apiKey) return { error: 'ElevenLabs API Key not configured. Set KHY_TTS_ELEVENLABS_API_KEY.' };

  const voiceId = options.voiceId || '21m00Tcm4TlvDq8ikWAM';
  const model = options.model || 'eleven_monolingual_v1';

  return new Promise((resolve) => {
    const data = JSON.stringify({ text, model_id: model });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true, audio: Buffer.concat(chunks), format: 'mp3', provider: 'elevenlabs' });
        } else {
          resolve({ error: `ElevenLabs error: ${res.statusCode}` });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(data);
    req.end();
  });
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI TTS', fn: openaiTTS },
  { id: 'elevenlabs', name: 'ElevenLabs', fn: elevenlabsTTS },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'openai': return !!(_env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    case 'elevenlabs': return !!_env('ELEVENLABS_API_KEY');
    default: return false;
  }
}

async function synthesize(providerId, text, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.fn(text, options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  synthesize,
  openaiTTS,
  elevenlabsTTS,
};
