'use strict';

/**
 * Real-time API service — WebSocket-based real-time communication.
 * Supports multiple providers: OpenAI, Gemini, Azure, Bedrock, Vertex AI, xAI.
 */

const WebSocket = require('ws');
const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_REALTIME_${name}`] || '').trim();
}

// ── OpenAI Realtime API ──
async function openaiConnect(options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const model = options.model || 'gpt-4o-realtime-preview';
  const url = `wss://api.openai.com/v1/realtime?model=${model}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    ws.on('open', () => {
      resolve({ success: true, ws, provider: 'openai', model });
    });

    ws.on('error', (err) => {
      resolve({ error: `OpenAI WebSocket error: ${err.message}` });
    });
  });
}

// ── Gemini Realtime API ──
async function geminiConnect(options = {}) {
  const apiKey = _env('GEMINI_API_KEY') || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { error: 'Gemini API Key not configured.' };

  const model = options.model || 'gemini-2.0-flash-exp';
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.BidiGenerateContent?key=${apiKey}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      resolve({ success: true, ws, provider: 'gemini', model });
    });

    ws.on('error', (err) => {
      resolve({ error: `Gemini WebSocket error: ${err.message}` });
    });
  });
}

// ── Azure Realtime API ──
async function azureConnect(options = {}) {
  const apiKey = _env('AZURE_OPENAI_API_KEY');
  const endpoint = _env('AZURE_OPENAI_ENDPOINT');
  if (!apiKey) return { error: 'Azure OpenAI API Key not configured.' };

  const model = options.model || 'gpt-4o-realtime-preview';
  const url = `wss://${new URL(endpoint).hostname}/openai/realtime?api-version=2024-10-01-preview&model=${model}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { 'api-key': apiKey },
    });

    ws.on('open', () => {
      resolve({ success: true, ws, provider: 'azure', model });
    });

    ws.on('error', (err) => {
      resolve({ error: `Azure WebSocket error: ${err.message}` });
    });
  });
}

// ── xAI Realtime API ──
async function xaiConnect(options = {}) {
  const apiKey = _env('XAI_API_KEY');
  if (!apiKey) return { error: 'xAI API Key not configured.' };

  const model = options.model || 'grok-2';
  const url = `wss://api.x.ai/v1/realtime?model=${model}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });

    ws.on('open', () => {
      resolve({ success: true, ws, provider: 'xai', model });
    });

    ws.on('error', (err) => {
      resolve({ error: `xAI WebSocket error: ${err.message}` });
    });
  });
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI Realtime', connect: openaiConnect },
  { id: 'gemini', name: 'Gemini Realtime', connect: geminiConnect },
  { id: 'azure', name: 'Azure Realtime', connect: azureConnect },
  { id: 'xai', name: 'xAI Realtime', connect: xaiConnect },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function isProviderConfigured(providerId) {
  switch (providerId) {
    case 'openai': return !!(_env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY);
    case 'gemini': return !!(_env('GEMINI_API_KEY') || process.env.GOOGLE_API_KEY);
    case 'azure': return !!_env('AZURE_OPENAI_API_KEY');
    case 'xai': return !!_env('XAI_API_KEY');
    default: return false;
  }
}

async function connect(providerId, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return { error: `Unknown provider: ${providerId}` };
  return provider.connect(options);
}

module.exports = {
  listProviders,
  isProviderConfigured,
  connect,
  openaiConnect,
  geminiConnect,
  azureConnect,
  xaiConnect,
};
