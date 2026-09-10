'use strict';

/**
 * Assistants API service — create and manage AI assistants.
 * Supports OpenAI Assistants API.
 */

const https = require('https');
const { URL } = require('url');

function _env(name) {
  return String(process.env[`KHY_ASSISTANTS_${name}`] || '').trim();
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
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
          'OpenAI-Beta': 'assistants=v2',
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

// ── OpenAI Assistants ──
async function openaiCreateAssistant(options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request('https://api.openai.com/v1/assistants', 'POST', {
    model: options.model || 'gpt-4o',
    name: options.name || 'Assistant',
    instructions: options.instructions || '',
    tools: options.tools || [],
    file_ids: options.fileIds || [],
    metadata: options.metadata || {},
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `OpenAI Assistants error: ${result.status}`, data: result.data };
  return { success: true, assistant: result.data, provider: 'openai' };
}

async function openaiListAssistants(limit = 20) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/assistants?limit=${limit}`, 'GET', null, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) return { error: `OpenAI Assistants error: ${result.status}` };
  return { success: true, assistants: result.data.data, provider: 'openai' };
}

async function openaiGetAssistant(assistantId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/assistants/${assistantId}`, 'GET', null, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) return { error: `OpenAI Assistants error: ${result.status}` };
  return { success: true, assistant: result.data, provider: 'openai' };
}

async function openaiDeleteAssistant(assistantId) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/assistants/${assistantId}`, 'DELETE', null, {
    'Authorization': `Bearer ${apiKey}`,
  });

  if (result.status !== 200) return { error: `OpenAI Assistants error: ${result.status}` };
  return { success: true, deleted: result.data.deleted, provider: 'openai' };
}

async function openaiCreateThread(options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request('https://api.openai.com/v1/threads', 'POST', {
    messages: options.messages || [],
    metadata: options.metadata || {},
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `OpenAI Thread error: ${result.status}` };
  return { success: true, thread: result.data, provider: 'openai' };
}

async function openaiCreateMessage(threadId, content, role = 'user') {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/threads/${threadId}/messages`, 'POST', {
    role,
    content,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `OpenAI Message error: ${result.status}` };
  return { success: true, message: result.data, provider: 'openai' };
}

async function openaiCreateRun(threadId, assistantId, options = {}) {
  const apiKey = _env('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
  if (!apiKey) return { error: 'OpenAI API Key not configured.' };

  const result = await _request(`https://api.openai.com/v1/threads/${threadId}/runs`, 'POST', {
    assistant_id: assistantId,
    model: options.model,
    instructions: options.instructions,
    tools: options.tools,
    stream: options.stream || false,
  }, { 'Authorization': `Bearer ${apiKey}` });

  if (result.status !== 200) return { error: `OpenAI Run error: ${result.status}` };
  return { success: true, run: result.data, provider: 'openai' };
}

// ── Provider registry ──
const PROVIDERS = {
  openai: {
    name: 'OpenAI Assistants',
    createAssistant: openaiCreateAssistant,
    listAssistants: openaiListAssistants,
    getAssistant: openaiGetAssistant,
    deleteAssistant: openaiDeleteAssistant,
    createThread: openaiCreateThread,
    createMessage: openaiCreateMessage,
    createRun: openaiCreateRun,
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
  openaiCreateAssistant,
  openaiListAssistants,
  openaiGetAssistant,
  openaiDeleteAssistant,
  openaiCreateThread,
  openaiCreateMessage,
  openaiCreateRun,
  PROVIDERS,
};
