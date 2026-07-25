/**
 * builtinProviderConfig — single source of truth for the built-in API providers
 * surfaced by the Key pool, plus a non-interactive key-apply path.
 *
 * The catalog (`BUILTIN_PROVIDERS`) used to live inline in
 * `cli/handlers/gateway.js`. It is the descriptor table that maps a provider to
 * its pool key, env-var names (envKey/envEndpoint), default endpoint and known
 * models. Moving it here lets BOTH the CLI/TUI flow AND an agent-callable tool
 * (`tools/ConfigureModelProvider`) consume one definition — a tool must NOT
 * import `cli/handlers/*` (reverse dependency), so the catalog and the apply
 * logic are anchored at the service layer.
 *
 * `applyBuiltinProviderKey()` reproduces the side effects of the classic CLI
 * "add provider key" flow (gateway.js `applyProviderKey`) using only services:
 *   - apiKeyPool.addKey            → persist key(s) to the pool
 *   - gatewayEnvFile.writeEnvMap   → set <PROVIDER>_API_KEY / _API_ENDPOINT
 *   - gatewayEnvFile.mergeJsonEnvVar → service/default-model/route maps
 * It is pure/non-interactive: callers collect input, this performs the writes.
 */
'use strict';

const { parseApiKeyEntries, extractPrimaryApiKey } = require('../apiKeyFormat');
const envFile = require('../gatewayEnvFile');

/**
 * Built-in API providers for the Key pool. Single source of truth shared by the
 * classic inquirer flow (handleGatewayConfig), the native TUI overlay
 * (getProviderKeyChoices / applyProviderKey) and the agent tool. Custom
 * providers are appended on top of this list by the classic flow from
 * customProviderRegistry.
 */
const BUILTIN_PROVIDERS = [
  { name: 'DeepSeek', poolKey: 'deepseek', envKey: 'DEEPSEEK_API_KEY', envEndpoint: 'DEEPSEEK_API_ENDPOINT', defaultEndpoint: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'] },
  { name: '通义千问 (Qwen)', poolKey: 'qwen', envKey: 'QWEN_API_KEY', envEndpoint: 'QWEN_API_ENDPOINT', defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-turbo', 'qwen-plus', 'qwen-max'] },
  { name: '智谱 GLM', poolKey: 'glm', envKey: 'GLM_API_KEY', envEndpoint: 'GLM_API_ENDPOINT', defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4', 'glm-4-flash', 'glm-4-air'] },
  { name: '豆包 (Doubao)', poolKey: 'doubao', envKey: 'DOUBAO_API_KEY', envEndpoint: 'DOUBAO_API_ENDPOINT', defaultEndpoint: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-lite-32k'] },
  { name: '百度文心', poolKey: 'wenxin', envKey: 'WENXIN_API_KEY', envEndpoint: 'WENXIN_API_ENDPOINT', defaultEndpoint: 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop', models: ['ernie-4.0', 'ernie-speed'] },
  { name: 'OpenAI', poolKey: 'openai', envKey: 'OPENAI_API_KEY', envEndpoint: 'OPENAI_API_ENDPOINT', defaultEndpoint: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'] },
  { name: 'Anthropic (Claude)', poolKey: 'anthropic', envKey: 'ANTHROPIC_API_KEY', envEndpoint: 'ANTHROPIC_API_ENDPOINT', defaultEndpoint: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'] },
  // Trae 原生协议（adaptive-api.trae.ai）非 OpenAI 兼容；defaultEndpoint 留空，避免误导用户填 api.trae.ai 后 404。
  { name: 'Trae API', poolKey: 'trae', envKey: 'TRAE_API_KEY', envEndpoint: 'TRAE_API_ENDPOINT', defaultEndpoint: '', models: ['gpt-4o', 'claude-3.5-sonnet', 'deepseek-v3', 'doubao-1.5-pro'] },
  { name: 'HuggingFace', poolKey: null, envKey: 'HF_TOKEN', envEndpoint: null, defaultEndpoint: null, models: [], isToken: true },
  { name: 'Relay (中转站)', poolKey: 'relay', envKey: 'RELAY_API_KEY', envEndpoint: 'RELAY_API_ENDPOINT', defaultEndpoint: '', models: [] },
];

/**
 * Overlay the gated GLM SSoT onto the '智谱 GLM' descriptor: when the
 * KHY_GLM_LATEST_MODEL gate is on, its models list leads with glm-5.2; when off
 * (or the leaf is unavailable) the descriptor byte-reverts to its static glm-4
 * list. Every other provider passes through untouched.
 * @param {object} p a fresh descriptor copy (safe to mutate)
 * @returns {object}
 */
function _withGlmLatest(p) {
  if (!p || p.poolKey !== 'glm') return p;
  try {
    const { latestGlmModelEnabled, knownZhipuModels } = require('../zhipuGlmModel');
    if (latestGlmModelEnabled()) p.models = knownZhipuModels();
  } catch { /* fail-soft: keep static glm models */ }
  return p;
}

/** Fresh shallow copies so callers can never mutate the shared descriptors. */
function listBuiltinProviders() {
  return BUILTIN_PROVIDERS.map((p) => _withGlmLatest({ ...p }));
}

/**
 * Resolve a builtin provider by display name OR pool key, case-insensitively.
 * Tolerates the catalog's parenthesised aliases (e.g. "通义千问 (Qwen)" matches
 * "qwen"/"Qwen", "Anthropic (Claude)" matches "anthropic"/"claude") and ignores
 * surrounding whitespace.
 *
 * @param {string} nameOrPoolKey
 * @returns {object|null} a fresh copy of the descriptor, or null when no match
 */
function findBuiltinProvider(nameOrPoolKey) {
  const needle = String(nameOrPoolKey || '').trim().toLowerCase();
  if (!needle) return null;
  for (const p of BUILTIN_PROVIDERS) {
    if (p.poolKey && p.poolKey.toLowerCase() === needle) return _withGlmLatest({ ...p });
    const name = String(p.name || '').toLowerCase();
    if (name === needle) return _withGlmLatest({ ...p });
    // Match any alias token inside the name: "anthropic (claude)" → {anthropic, claude}.
    const tokens = name.split(/[()\s/]+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.includes(needle)) return _withGlmLatest({ ...p });
  }
  return null;
}

/**
 * Persist a builtin provider's API key: pool + env + (optional) route map.
 * Non-interactive port of gateway.js `applyProviderKey` common path.
 *
 * @param {object} input
 * @param {object|string} input.provider  a BUILTIN_PROVIDERS descriptor, or a
 *        name/poolKey resolvable via findBuiltinProvider
 * @param {string} input.keyInput         raw API key string (parseApiKeyEntries format)
 * @param {string} [input.endpoint]       base URL override (default: provider.defaultEndpoint)
 * @param {string} [input.model]          model id to set as default + route
 * @param {number} [input.priority=10]
 * @param {string} [input.label='']
 * @param {object} [deps]                  injectable {pool, env} for testing
 * @returns {{poolKey:(string|null), added:number, duplicate:number, primaryKey:string,
 *            endpoint:string, model:string, token?:boolean, models:string[]}}
 */
function applyBuiltinProviderKey(input = {}, deps = {}) {
  const provider = typeof input.provider === 'object' && input.provider
    ? input.provider
    : findBuiltinProvider(input.provider);
  if (!provider) throw new Error(`未知的内置厂商: ${input.provider}`);

  const keyInput = input.keyInput;
  if (!keyInput || !String(keyInput).trim()) throw new Error('未输入 API Key');

  const env = deps.env || envFile;
  // Lazy-require the pool so tests can inject a stub without touching disk.
  let pool = deps.pool;
  if (!pool) {
    pool = require('../apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
  }

  const priority = input.priority != null ? parseInt(input.priority, 10) || 0 : 10;
  const label = input.label || '';
  const endpoint = input.endpoint != null ? input.endpoint : provider.defaultEndpoint;
  const model = input.model || '';

  // HuggingFace-style token-only providers: save straight to env.
  if (provider.isToken) {
    const hfPrimary = extractPrimaryApiKey(keyInput);
    if (!hfPrimary) throw new Error('未解析到有效 Token');
    env.writeEnvMap({ [provider.envKey]: String(hfPrimary) });
    return { poolKey: provider.poolKey, added: 0, duplicate: 0, primaryKey: String(hfPrimary), endpoint: '', model: '', token: true, models: [] };
  }

  const parsedEntries = parseApiKeyEntries(keyInput, { endpoint, priority, label });
  if (parsedEntries.length === 0) throw new Error('未解析到有效 API Key');
  const primaryKey = parsedEntries[0].key;

  // 1. add key(s) to the pool
  let added = 0;
  let duplicate = 0;
  if (provider.poolKey) {
    for (const entry of parsedEntries) {
      try { pool.addKey(provider.poolKey, entry); added += 1; }
      catch (e) {
        if (/already exists/i.test(String(e && e.message))) duplicate += 1;
        else throw e;
      }
    }
  }

  // 2. env vars for the provider (first key), mirroring the classic flow
  if (provider.envKey) {
    env.writeEnvMap({ [provider.envKey]: String(primaryKey) });
    if (provider.envEndpoint && endpoint) env.writeEnvMap({ [provider.envEndpoint]: String(endpoint) });
    if (/_API_KEY$/i.test(provider.envKey)) {
      const prefix = provider.envKey.replace(/_API_KEY$/i, '');
      if (parsedEntries.length > 1) env.writeEnvMap({ [`${prefix}_API_KEYS`]: parsedEntries.map((e) => e.key).join(',') });
      else env.unsetEnvKeys([`${prefix}_API_KEYS`]);
    }
  }

  // 3. model selection + route map (only when a model was chosen)
  if (model && provider.poolKey) {
    env.mergeJsonEnvVar('GATEWAY_API_POOL_SERVICE_MAP', { [provider.poolKey]: 'openai' });
    env.mergeJsonEnvVar('GATEWAY_API_POOL_DEFAULT_MODEL_MAP', { [provider.poolKey]: model });
    const routeEntries = {};
    for (const m of (provider.models || [])) {
      routeEntries[m] = { target: `api:${provider.poolKey}:${m}`, strict: true };
    }
    env.mergeJsonEnvVar('PROXY_MODEL_ROUTE_MAP', routeEntries);
  }

  return {
    poolKey: provider.poolKey,
    added,
    duplicate,
    primaryKey,
    endpoint: String(endpoint || ''),
    model,
    models: (provider.models || []).slice(),
  };
}

module.exports = {
  BUILTIN_PROVIDERS,
  listBuiltinProviders,
  findBuiltinProvider,
  applyBuiltinProviderKey,
};
