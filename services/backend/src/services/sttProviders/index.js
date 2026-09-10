'use strict';

/**
 * Speech-to-Text (STT) Provider Extensions
 * Adds support for multiple STT/Transcription APIs.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

function _env(name) {
  return String(process.env[`KHY_STT_${name}`] || '').trim();
}

function _request(urlStr, method = 'GET', body = null, headers = {}) {
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
      req.setTimeout(60000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) {
      resolve({ status: 0, error: e.message });
    }
  });
}

// ── Deepgram Transcription ──
async function deepgramTranscribe(audioBuffer, options = {}) {
  const apiKey = _env('DEEPGRAM_API_KEY');
  if (!apiKey) return { error: 'Deepgram API Key not configured. Set KHY_STT_DEEPGRAM_API_KEY.' };

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.deepgram.com',
      path: '/v1/listen?model=nova-2&smart_format=true',
      method: 'POST',
      headers: { 'Authorization': `Token ${apiKey}`, 'Content-Type': options.contentType || 'audio/wav' },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode === 200) {
            resolve({ success: true, text: json.results?.channels?.[0]?.alternatives?.[0]?.transcript || '', provider: 'deepgram' });
          } else {
            resolve({ error: `Deepgram error: ${res.statusCode}` });
          }
        } catch (e) { resolve({ error: body }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(audioBuffer);
    req.end();
  });
}

// ── ElevenLabs STT ──
async function elevenlabsTranscribe(audioBuffer, options = {}) {
  const apiKey = _env('ELEVENLABS_API_KEY');
  if (!apiKey) return { error: 'ElevenLabs API Key not configured.' };

  return new Promise((resolve) => {
    const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/speech-to-text',
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody);
          if (res.statusCode === 200) {
            resolve({ success: true, text: json.text || '', provider: 'elevenlabs' });
          } else {
            resolve({ error: `ElevenLabs STT error: ${res.statusCode}` });
          }
        } catch (e) { resolve({ error: responseBody }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

// ── OpenAI Whisper API ──
async function whisperTranscribe(audioBuffer, options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured for Whisper.' };

  return new Promise((resolve) => {
    const boundary = '----FormBoundary' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      audioBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let responseBody = '';
      res.on('data', (c) => { responseBody += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody);
          if (res.statusCode === 200) {
            resolve({ success: true, text: json.text || '', provider: 'whisper' });
          } else {
            resolve({ error: `Whisper error: ${res.statusCode}` });
          }
        } catch (e) { resolve({ error: responseBody }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'deepgram', name: 'Deepgram', fn: deepgramTranscribe },
  { id: 'elevenlabs', name: 'ElevenLabs STT', fn: elevenlabsTranscribe },
  { id: 'whisper', name: 'OpenAI Whisper', fn: whisperTranscribe },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'deepgram': return !!_env('DEEPGRAM_API_KEY');
    case 'elevenlabs': return !!_env('ELEVENLABS_API_KEY');
    case 'whisper': return !!(_env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    default: return false;
  }
}

async function transcribe(providerId, audioBuffer, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.fn(audioBuffer, options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  transcribe,
  deepgramTranscribe,
  elevenlabsTranscribe,
  whisperTranscribe,
};
