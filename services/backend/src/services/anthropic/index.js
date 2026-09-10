'use strict';

/**
 * Anthropic interface extensions — enhanced Claude integration.
 * Adds support for Anthropic-specific features like prompt caching, tool use, etc.
 */

function _env(name) {
  return String(process.env[`KHY_ANTHROPIC_${name}`] || '').trim();
}

function _getApiKey() {
  return _env('API_KEY') || process.env.ANTHROPIC_API_KEY;
}

// ── Prompt Caching ──
function createSystemPromptWithCache(systemPrompt, cacheBreakpoint = true) {
  if (!cacheBreakpoint) {
    return [{ type: 'text', text: systemPrompt }];
  }
  return [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' },
  }];
}

// ── Tool Definition Formatter ──
function formatToolForAnthropic(name, description, inputSchema) {
  return {
    name,
    description,
    input_schema: {
      type: 'object',
      properties: inputSchema.properties || {},
      required: inputSchema.required || [],
    },
  };
}

// ── Extended Thinking ──
function configureExtendedThinking(budget = 10000, type = 'enabled') {
  return {
    type,
    budget_tokens: budget,
  };
}

// ── Token Count ──
async function countTokens(model, messages) {
  const apiKey = _getApiKey();
  if (!apiKey) return { error: 'Anthropic API Key not configured.' };

  const https = require('https');
  const { URL } = require('url');

  return new Promise((resolve) => {
    const url = new URL('https://api.anthropic.com/v1/messages/count_tokens');
    const data = JSON.stringify({ model, messages });

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let responseData = '';
      res.on('data', (c) => { responseData += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(responseData) }); }
        catch { resolve({ status: res.statusCode, error: responseData }); }
      });
    });

    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.write(data);
    req.end();
  });
}

// ── Provider status ──
function isConfigured() {
  return !!_getApiKey();
}

function getCapabilities() {
  return {
    promptCaching: true,
    extendedThinking: true,
    toolUse: true,
    vision: true,
    computerUse: true,
    tokenCounting: true,
  };
}

module.exports = {
  createSystemPromptWithCache,
  formatToolForAnthropic,
  configureExtendedThinking,
  countTokens,
  isConfigured,
  getCapabilities,
  PROVIDERS: [
    { id: 'anthropic', name: 'Anthropic Claude', configured: !!_getApiKey() },
  ],
};
