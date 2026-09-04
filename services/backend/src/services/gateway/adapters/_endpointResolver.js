'use strict';

/**
 * _endpointResolver.js — 从 adapter key 解析端点 URL。
 *
 * 零硬编码：所有端点从 serviceDefaults.js 或环境变量解析。
 *
 * @module gateway/adapters/_endpointResolver
 */

// ── 端点注册表（从环境变量 / serviceDefaults 导入）─────────────
function resolveAdapterEndpoint(adapterKey) {
  const defaults = require('../../../constants/serviceDefaults');

  // 按优先级解析：env > serviceDefaults > 空
  const endpointMap = {
    api: defaults.API_ENDPOINT || process.env.KHY_API_ENDPOINT,
    relay_api: defaults.RELAY_API_ENDPOINT || process.env.RELAY_API_ENDPOINT,
    relay: defaults.RELAY_API_ENDPOINT || process.env.RELAY_API_ENDPOINT,
    claude: defaults.CLAUDE_API_ENDPOINT || process.env.CLAUDE_API_ENDPOINT || 'https://api.anthropic.com',
    openai: defaults.OPENAI_API_ENDPOINT || process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com',
    deepseek: defaults.DEEPSEEK_API_ENDPOINT || process.env.DEEPSEEK_API_ENDPOINT || 'https://api.deepseek.com',
    ollama: defaults.OLLAMA_ENDPOINT || process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',
    localllm: defaults.LOCAL_LLM_ENDPOINT || process.env.LOCAL_LLM_ENDPOINT,
  };

  return endpointMap[adapterKey] || '';
}

module.exports = {
  resolveAdapterEndpoint,
};
