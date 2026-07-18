/**
 * providerPresets — single source of truth for built-in common model providers.
 *
 * Picking a preset just *fills in* a form: its public base URL, wire protocol
 * (apiFormat), auth header field and a default model. The user still supplies
 * their own key and may edit every field. Both planes consume this one source:
 *   - per-user (services/ai-backend): GET /api/user-gateway/provider-presets,
 *     used by the MyGateway relay + custom-provider cards.
 *   - admin (customProviderRegistrar.getPresets): derives its OpenAI-only
 *     preset list from here, so adding a provider once surfaces it everywhere.
 *
 * Hard rules honoured here:
 *   - NO hardcoded secrets: a preset is public reference data (endpoints), never
 *     a key. getProviderPresets() actively strips any `key`/`apiKey` field.
 *   - Overridable, not frozen: env KHY_PROVIDER_PRESETS (a JSON array) merges by
 *     `id` to override a built-in endpoint or add a private one — same pattern as
 *     KHY_MODEL_TIER_MAP / KHY_MODEL_CAPABILITY_MAP. No code change needed.
 *   - apiFormat is validated against the same set the per-user gateway accepts.
 */
'use strict';

// Mirror userGatewayConfigService.API_FORMATS so a preset can never carry a
// protocol the per-user relay would reject at save time.
const VALID_API_FORMATS = ['openai', 'anthropic', 'openai_responses', 'gemini'];

/**
 * Derive the auth header field from the wire protocol when a preset omits it.
 * anthropic → x-api-key, gemini → x-goog-api-key, everything else → Bearer.
 */
function keyFieldForFormat(apiFormat) {
  if (apiFormat === 'anthropic') return 'x-api-key';
  if (apiFormat === 'gemini') return 'x-goog-api-key';
  return 'authorization_bearer';
}

/**
 * Built-in seed. Endpoints reuse the repo's authoritative values
 * (apps/ai-frontend/src/views/AIGateway.vue relayProfilePresets +
 * customProviderRegistrar Agnes) plus widely-published Chinese providers.
 *
 * tier '' = automatic modelTier classification (no per-model hardcoding).
 */
// `links` is public reference data so a user always knows WHERE to get a key:
//   home    = the provider's homepage,
//   console = the page to create/manage API keys (the "get a key" target),
//   docs    = API documentation.
// Same hard rules as the rest of a preset: public URLs only, never a secret, and
// overridable per-id via env KHY_PROVIDER_PRESETS. A missing link is simply omitted.
const PROVIDER_PRESETS = [
  // ── Authoritative (already defined in-repo) ──
  { id: 'openai', label: 'OpenAI 官方', category: 'official', baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: 'gpt-4o-mini', models: [], tier: '', links: { home: 'https://openai.com', console: 'https://platform.openai.com/api-keys', docs: 'https://platform.openai.com/docs' } },
  { id: 'anthropic', label: 'Anthropic 官方', category: 'official', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', compatibility: 'anthropic', keyField: 'x-api-key', defaultModel: 'claude-sonnet-4-20250514', models: [], tier: '', links: { home: 'https://www.anthropic.com', console: 'https://console.anthropic.com/settings/keys', docs: 'https://docs.anthropic.com' } },
  { id: 'gemini', label: 'Google Gemini', category: 'official', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'gemini', compatibility: 'unknown', keyField: 'x-goog-api-key', defaultModel: 'gemini-2.0-flash', models: [], tier: '', links: { home: 'https://ai.google.dev', console: 'https://aistudio.google.com/app/apikey', docs: 'https://ai.google.dev/gemini-api/docs' } },
  // Vertex 复用 Gemini 线格式,但 URL 走 …-aiplatform.googleapis.com/…/projects/{project}/locations/{location}/publishers/google,
  // 鉴权用 OAuth2 access token 作 Bearer(keyField=authorization_bearer)。baseUrl 是模板:用户填自己的 project/location;
  // 现有 gemini relay 分支会再拼 `/models/${model}:generateContent`,故模板止于 …/publishers/google 即得正确 Vertex URL。
  // key 处粘贴 `gcloud auth print-access-token` 的输出。URL 成形单一真源见纯叶子 gateway/vertexRequestShaping.js。
  { id: 'vertex', label: 'Google Vertex AI', category: 'official', baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT/locations/us-central1/publishers/google', apiFormat: 'gemini', compatibility: 'unknown', keyField: 'authorization_bearer', defaultModel: '', models: [], tier: '', keyExample: 'ya29.<oauth-access-token: gcloud auth print-access-token>', links: { home: 'https://cloud.google.com/vertex-ai', console: 'https://console.cloud.google.com/vertex-ai', docs: 'https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference' } },
  { id: 'deepseek', label: 'DeepSeek', category: 'official', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: 'deepseek-chat', models: [], tier: '', links: { home: 'https://www.deepseek.com', console: 'https://platform.deepseek.com/api_keys', docs: 'https://api-docs.deepseek.com' } },
  { id: 'agnes', label: 'Agnes AI', category: 'official', baseUrl: 'https://apihub.agnes-ai.com/v1', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: 'agnes-2.0-flash', models: ['agnes-2.0-flash'], tier: '', keyExample: 'sk-agnes-xxxxxxxxxxxxxxxx', links: { home: 'https://agnes-ai.com', console: 'https://apihub.agnes-ai.com' } },
  { id: 'shengsuanyun', label: '胜算云', category: 'partner', baseUrl: 'https://router.shengsuanyun.com/api/v1', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: '', models: [], tier: '', links: { home: 'https://www.shengsuanyun.com', console: 'https://router.shengsuanyun.com' } },
  { id: 'packycode', label: 'PackyCode', category: 'partner', baseUrl: 'https://api.packyapi.com/v1', apiFormat: 'anthropic', compatibility: 'anthropic', keyField: 'x-api-key', defaultModel: '', models: [], tier: '', links: { home: 'https://www.packycode.com', console: 'https://www.packycode.com' } },
  // ── Common Chinese providers (public OpenAI-compatible endpoints) ──
  { id: 'moonshot', label: 'Moonshot / Kimi', category: 'official', baseUrl: 'https://api.moonshot.cn/v1', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: 'moonshot-v1-8k', models: [], tier: '', links: { home: 'https://www.moonshot.cn', console: 'https://platform.moonshot.cn/console/api-keys', docs: 'https://platform.moonshot.cn/docs' } },
  { id: 'qwen', label: '通义千问 / DashScope', category: 'official', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: 'qwen-plus', models: [], tier: '', links: { home: 'https://dashscope.aliyun.com', console: 'https://bailian.console.aliyun.com', docs: 'https://help.aliyun.com/zh/model-studio' } },
  { id: 'zhipu', label: '智谱 GLM', category: 'official', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiFormat: 'openai', compatibility: 'openai', keyField: 'authorization_bearer', defaultModel: 'glm-4', models: [], tier: '', links: { home: 'https://www.zhipuai.cn', console: 'https://open.bigmodel.cn/usercenter/apikeys', docs: 'https://open.bigmodel.cn/dev/api' } },
];

const LINK_KEYS = ['home', 'console', 'docs'];

/**
 * Keep only known link keys whose value is a syntactically valid http(s) URL.
 * Anything else (relative path, javascript:, garbage) is dropped — these URLs
 * render as clickable links in the UI, so we never emit an untrusted scheme.
 */
function sanitizeLinks(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const k of LINK_KEYS) {
    const v = String(raw[k] || '').trim();
    if (!v || !/^https?:\/\//i.test(v)) continue;
    try { new URL(v); out[k] = v; } catch { /* drop invalid */ }
  }
  return out;
}

/**
 * Sanitise one preset entry into the canonical shape, or return null to drop it.
 * Never lets a key/secret survive; rejects an unsupported apiFormat.
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase();
  if (!id) return null;

  const apiFormat = String(raw.apiFormat || 'openai').trim();
  if (!VALID_API_FORMATS.includes(apiFormat)) return null; // 防呆: unsupported protocol

  return {
    id,
    label: String(raw.label || id),
    category: String(raw.category || 'custom'),
    baseUrl: String(raw.baseUrl || '').trim(),
    apiFormat,
    compatibility: String(raw.compatibility || (apiFormat === 'anthropic' ? 'anthropic' : 'openai')),
    keyField: String(raw.keyField || keyFieldForFormat(apiFormat)),
    defaultModel: String(raw.defaultModel || '').trim(),
    models: Array.isArray(raw.models) ? raw.models.map((m) => String(m)).filter(Boolean) : [],
    tier: String(raw.tier || ''),
    // Example API-key shape (e.g. `sk-agnes-xxxx`) used as a form placeholder so
    // the user sees the expected format. Example text ONLY — never a real key.
    keyExample: String(raw.keyExample || ''),
    // Public reference links (home/console/docs) so the UI can show "where to get
    // a key". Validated to http(s) only; an env override may add/replace them.
    links: sanitizeLinks(raw.links),
    // NOTE: any raw.key / raw.apiKey is intentionally NOT copied — presets are
    // key-less metadata; the user always supplies their own credential.
  };
}

/**
 * Parse env KHY_PROVIDER_PRESETS into an array of overrides/additions.
 * Malformed JSON or a non-array value is ignored (fail-soft, never throws).
 */
function readEnvOverrides() {
  const raw = process.env.KHY_PROVIDER_PRESETS;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The merged, sanitised preset list. Built-ins first, then env overrides applied
 * by `id` (override replaces, new id appends). Always a fresh deep copy so a
 * caller mutating the result can never corrupt the shared definitions.
 */
function getProviderPresets() {
  const byId = new Map();
  for (const p of PROVIDER_PRESETS) {
    const clean = sanitize(p);
    if (clean) byId.set(clean.id, clean);
  }
  // zhipu 默认/清单经 gated SSoT 叶子收敛到 glm-5.2(KHY_GLM_LATEST_MODEL 默认开);
  // 关门 → 保持静态 preset 的 glm-4 默认与空清单(逐字节回退)。env 覆盖仍在下方后应用而胜出。
  try {
    const zhipu = byId.get('zhipu');
    if (zhipu) {
      const { latestGlmModelEnabled, defaultZhipuModel, knownZhipuModels } = require('../zhipuGlmModel');
      if (latestGlmModelEnabled()) {
        byId.set('zhipu', sanitize({ ...zhipu, defaultModel: defaultZhipuModel(), models: knownZhipuModels() }) || zhipu);
      }
    }
  } catch { /* fail-soft: keep static zhipu preset */ }
  for (const o of readEnvOverrides()) {
    const id = String(o && o.id ? o.id : '').trim().toLowerCase();
    if (!id) continue;
    // Merge over the built-in (if any) so a partial override (e.g. just baseUrl)
    // keeps the rest of the built-in fields, then re-sanitise the result.
    const merged = sanitize({ ...(byId.get(id) || { id }), ...o, id });
    if (merged) byId.set(id, merged);
  }
  return Array.from(byId.values());
}

module.exports = {
  getProviderPresets,
  keyFieldForFormat,
  VALID_API_FORMATS,
  // Exposed for tests/derivation only; callers should prefer getProviderPresets().
  PROVIDER_PRESETS,
};
