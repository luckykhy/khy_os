/**
 * Management resource: gateway upstream / relay model config.
 *
 * Source of truth: the gateway .env (canonical backend/.env + mirror
 * services/.env), written exclusively through services/gatewayEnvFile.js. This
 * is the resource that ENDS the old contradiction where the Web admin wrote a
 * hardcoded backend/.env directly (bypassing KHY_ENV_FILE and the services/.env
 * mirror) while the CLI went through gatewayEnvFile. Now both surfaces invoke
 * `set` here, which delegates to gatewayEnvFile.writeEnvPatch — one writer.
 *
 * The API key is never returned: get reports only a masked form + hasApiKey.
 */
const { resolveEnvPaths, writeEnvPatch } = require('../../gatewayEnvFile');

const VALID_COMPAT = ['openai', 'anthropic', 'unknown'];

// 收敛到 utils/maskSecret 单一真源(逐字节委托,调用点不变)
const _maskKey = require('../../../utils/maskSecret');

function _snapshot() {
  const apiKey = String(process.env.RELAY_API_KEY || '').trim();
  const rawCompat = String(process.env.RELAY_API_COMPATIBILITY || 'openai').trim().toLowerCase();
  return {
    baseUrl: String(process.env.RELAY_API_ENDPOINT || '').trim(),
    modelId: String(process.env.RELAY_API_MODEL || '').trim(),
    compatibility: VALID_COMPAT.includes(rawCompat) ? rawCompat : 'openai',
    preferredAdapter: String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim(),
    preferredModel: String(process.env.GATEWAY_PREFERRED_MODEL || '').trim(),
    hasApiKey: !!apiKey,
    apiKeyMasked: apiKey ? _maskKey(apiKey) : '',
  };
}

/** @type {import('../resourceContract').Contract} */
const contract = {
  id: 'model-config',
  label: '网关上游/relay 配置',
  source: 'env',
  sourceDetail: resolveEnvPaths().canonicalPath,
  capabilities: ['get', 'set'],
  schema: {
    set: {
      baseUrl: { type: 'string', required: true },
      modelId: { type: 'string', required: true },
      compatibility: { type: 'string', required: false },
      apiKey: { type: 'string', required: false },
      clearApiKey: { type: 'boolean', required: false },
    },
  },
  ops: {
    async get() {
      return _snapshot();
    },
    async set(args) {
      const baseUrl = String(args?.baseUrl || '').trim();
      const modelId = String(args?.modelId || '').trim();
      if (!baseUrl) throw new Error('baseUrl is required');
      if (!modelId) throw new Error('modelId is required');

      const rawCompat = String(args?.compatibility || 'openai').trim().toLowerCase();
      const compatibility = VALID_COMPAT.includes(rawCompat) ? rawCompat : 'openai';
      const clearApiKey = args?.clearApiKey === true;
      const apiKeyInput = String(args?.apiKey || '').trim();

      // Normalize baseUrl: ensure /v1 suffix.
      let normalizedUrl = baseUrl.replace(/\/+$/, '');
      let appendedV1 = false;
      if (!normalizedUrl.endsWith('/v1')) {
        normalizedUrl += '/v1';
        appendedV1 = true;
      }

      const envMap = {
        GATEWAY_PREFERRED_ADAPTER: 'relay_api',
        GATEWAY_PREFERRED_STRICT: 'true',
        GATEWAY_PREFERRED_MODEL: modelId,
        RELAY_API_ENDPOINT: normalizedUrl,
        RELAY_API_MODEL: modelId,
        RELAY_API_COMPATIBILITY: compatibility,
      };
      const unsetKeys = [];
      if (clearApiKey) {
        unsetKeys.push('RELAY_API_KEY', 'RELAY_API_KEYS');
      } else if (apiKeyInput) {
        envMap.RELAY_API_KEY = apiKeyInput;
      }

      // Single writer: canonical + mirror + process.env, honouring KHY_ENV_FILE.
      writeEnvPatch(envMap, unsetKeys);

      return { updated: true, appendedV1, config: _snapshot() };
    },
  },
};

module.exports = contract;
