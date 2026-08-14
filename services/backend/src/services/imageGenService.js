'use strict';

/**
 * imageGenService — text-to-image generation across pluggable backends.
 *
 * Capability "image_gen" (画图/绘图/文生图) was declared in the gateway
 * capabilityRegistry but had no implementation, so the model would recognize a
 * drawing intent yet find no callable tool and return empty text. This service
 * is that missing implementation. The tool wrapper lives in
 * tools/imageGenerate.js; the diagnostic layer (cli/ai.js) reuses
 * isAnyBackendConfigured() to tell "no backend configured" apart from a genuine
 * empty model reply.
 *
 * Three backends, selected by env (zero-hardcoding — no model/key/url baked in):
 *   - openai   : OpenAI-compatible POST /v1/images/generations
 *   - agnes    : Agnes AI (Sapiens) images API. OpenAI-shaped but with two
 *                non-standard conventions: `response_format` and the img2img
 *                `image[]` array live inside `extra_body` (top-level
 *                `response_format` returns HTTP 400). Supports text-to-image AND
 *                image-to-image / multi-image compositing in one endpoint.
 *   - domestic : a Chinese text-to-image API; OpenAI-compatible-first with a
 *                configurable RESPONSE_PATH + URL-result download for the rest
 *   - sd_webui : a local Stable Diffusion WebUI (AUTOMATIC1111) /sdapi/v1/txt2img
 *
 * State transparency: every result reports the backend, model/provider, and
 * saved paths it actually used. Cross-platform: callers handle path resolution;
 * this module only deals with HTTP + base64.
 */

const { fetchWithTimeout } = require('./fetchTimeout');

const DEFAULT_TIMEOUT_MS = 120_000;

// ── Smart size resolution ──────────────────────────────────────────────
// SenseNova has a strict size whitelist. Instead of hardcoding one fallback,
// analyze the user's prompt to pick the most appropriate aspect ratio, then
// select the best matching size from the backend's supported list.

// Aspect-ratio hints from prompt keywords.
const _ASPECT_RATIO_HINTS = Object.freeze({
  // Vertical / portrait — content is taller than wide
  portrait: [
    '海报',
    '壁纸',
    '手机壁纸',
    '竖图',
    '竖版',
    '竖屏',
    '头像',
    '手机竖屏',
    'poster',
    'portrait',
    'phone wallpaper',
    'vertical',
    'tall',
  ],
  // Wide / landscape — content is wider than tall
  landscape: [
    '横图',
    '横版',
    '横屏',
    '宽屏',
    '宽图',
    'banner',
    'landscape',
    'wide',
    'wallpaper',
    'panorama',
    '风景',
    '场景',
    '背景图',
  ],
  // Square — roughly equal dimensions
  square: ['头像', '图标', 'icon', 'avatar', 'logo', 'square', '1:1'],
});

/**
 * Infer the desired aspect ratio category from the user's prompt.
 * Returns 'landscape' | 'portrait' | 'square' | null (no strong signal).
 */
function _inferAspectRatio(prompt) {
  const lower = String(prompt || '').toLowerCase();
  // Check each category; return the first match found.
  for (const [category, keywords] of Object.entries(_ASPECT_RATIO_HINTS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        // '头像' and 'logo' → square; '壁纸' and 'wallpaper' → landscape (desktop wallpaper)
        if (category === 'portrait' && (kw === '头像' || kw === 'avatar')) {
          return 'square';
        }
        if (category === 'landscape' && (kw === '壁纸' || kw === 'wallpaper')) {
          return 'landscape';
        }
        if (category === 'square' && (kw === '壁纸' || kw === 'wallpaper')) {
          return 'landscape';
        }
        return category;
      }
    }
  }
  // Default: landscape is the safest general-purpose choice for AI images
  return 'landscape';
}

/**
 * SenseNova's full supported size list (from API error messages).
 * Organized by aspect-ratio category for prompt-based selection.
 */
const _SENSENOVA_SIZES = Object.freeze({
  portrait: ['1664x2496', '1760x2368', '1824x2272', '1536x2752'],
  landscape: [
    '2496x1664',
    '2368x1760',
    '2272x1824',
    '2752x1536',
    '3072x1376',
    '2560x720',
    '3072x864',
  ],
  square: ['2048x2048'],
});

// Other backends accept standard OpenAI-style sizes; 1024x1024 is universal.
const _GENERIC_BACKEND_SIZES = Object.freeze({
  portrait: ['1024x1536'],
  landscape: ['1536x1024'],
  square: ['1024x1024'],
});

/**
 * Pick the best size for a given backend and prompt.
 *
 * For SenseNova: choose from its strict whitelist by aspect ratio.
 * For other backends: use standard sizes that most APIs accept.
 *
 * @param {string} prompt     - The user's image prompt (for aspect-ratio inference)
 * @param {string} backend    - Backend id
 * @param {string} [explicit] - User-specified size; returned as-is if provided
 * @returns {string} size string like "2752x1536"
 */
function resolveSize(prompt, backend, explicit) {
  if (explicit && String(explicit).trim()) {
    return String(explicit).trim();
  }
  const ratio = _inferAspectRatio(prompt);
  if (backend === 'sensenova') {
    const pool = _SENSENOVA_SIZES[ratio] || _SENSENOVA_SIZES.landscape;
    return pool[pool.length - 1]; // pick the largest in the category
  }
  const pool = _GENERIC_BACKEND_SIZES[ratio] || _GENERIC_BACKEND_SIZES.square;
  return pool[0];
}

// ── Prompt enhancement ──────────────────────────────────────────────────
// When the user's prompt is short (≤10 chars) or lacks depth keywords,
// append quality/style descriptors so the model produces a more polished,
// visually faithful result. Gate: KHY_IMAGE_GEN_ENHANCE_PROMPT (default on).

const _ENHANCE_GATE = String(process.env.KHY_IMAGE_GEN_ENHANCE_PROMPT || 'on').toLowerCase();

// Keywords that signal a "rich enough" prompt already — skip enhancement.
// All lowercase for case-insensitive matching.
const _DEPTH_KEYWORDS = Object.freeze([
  'high quality',
  'highly detailed',
  'masterpiece',
  '8k',
  '4k',
  'ultra',
  'photorealistic',
  'cinematic',
  'dramatic',
  'studio',
  'soft light',
  'rim light',
  'bokeh',
  'sharp focus',
  'octane',
  'unreal',
  'concept art',
  'digital art',
  'watercolor',
  'oil painting',
  'sketch',
  'anime style',
  'pixar',
  'golden hour',
  'award-winning',
  'editorial',
  'wildlife',
  '高清',
  '精细',
  '大师',
  '写实',
  '电影',
  '戏剧',
  '柔和光',
  '景深',
  '锐利',
  '插画',
  '水彩',
  '油画',
  '素描',
  '概念艺术',
  '数字艺术',
  '赛博朋克',
  '蒸汽朋克',
  '吉卜力',
  '新海诚',
  '水墨',
  '工笔',
  '专业',
  '超清',
  '极致',
  '惊艳',
  '唯美',
  '治愈',
  '氛围感',
  '动漫风格',
  '写实风格',
  '治愈系',
  '高级感',
]);

// Subject category detection for targeted modifier selection.
// All lowercase; checked against lowercased prompt.
const _SUBJECT_HINTS = Object.freeze({
  portrait: [
    '人',
    '女孩',
    '男孩',
    '男人',
    '女人',
    '少女',
    '少年',
    'face',
    'portrait',
    'person',
    'girl',
    'boy',
    'man',
    'woman',
    'avatar',
    '头像',
    '肖像',
    '面容',
    '侧脸',
    '特写',
    '自拍',
  ],
  animal: [
    '猫',
    '狗',
    '兔',
    '鸟',
    '鱼',
    '熊猫',
    '老虎',
    '龙',
    'horse',
    'cat',
    'dog',
    'rabbit',
    'bird',
    'dragon',
    'panda',
    'tiger',
    'fish',
    'pet',
    '动物',
    '宠物',
    '仓鼠',
    '企鹅',
  ],
  landscape: [
    '风景',
    '山',
    '海',
    '湖',
    '森林',
    '城市',
    '日落',
    '星空',
    '夜景',
    'mountain',
    'ocean',
    'sea',
    'forest',
    'sunset',
    'stars',
    'landscape',
    'scenery',
    '天空',
    '云',
    '沙漠',
    '雪',
    '草原',
    '海滩',
  ],
  object: [
    '车',
    '房子',
    '花',
    '树',
    '建筑',
    '手机',
    '电脑',
    'car',
    'house',
    'flower',
    'tree',
    'building',
    'phone',
    '电脑',
    '汽车',
    '房子',
    '花朵',
    '建筑',
    '机器人',
    '火箭',
    '船',
    '椅子',
    '灯',
    '杯子',
  ],
  food: [
    '食物',
    '蛋糕',
    '咖啡',
    '茶',
    '美食',
    'food',
    'cake',
    'coffee',
    'pizza',
    'sushi',
    '甜点',
    '饮料',
    '料理',
    '餐点',
    '面包',
    '巧克力',
    '水果',
  ],
  fashion: [
    '服装',
    '衣服',
    '裙子',
    '鞋子',
    '包包',
    'fashion',
    'dress',
    'shoes',
    'bag',
    'clothing',
    'outfit',
    '穿搭',
    '时装',
    '礼服',
    '西装',
  ],
  scifi: [
    '科幻',
    '未来',
    '机器人',
    '太空',
    'cyberpunk',
    'sci-fi',
    'future',
    'space',
    'robot',
    '霓虹',
    '全息',
    '赛博',
    '飞船',
    '外星',
  ],
});

// Category-specific quality boosters — appended in order.
const _CATEGORY_BOOST = Object.freeze({
  portrait: [
    'perfect face',
    'beautiful',
    'elegant pose',
    'soft lighting',
    'professional portrait photography',
    'sharp focus on eyes',
    '自然光',
    '精致面容',
    '柔和光线',
    '专业人像摄影',
  ],
  animal: [
    'wildlife photography',
    'national geographic',
    'cute',
    'detailed fur',
    'sharp focus',
    'natural habitat',
    '自然栖息地',
    '毛绒细节',
    '生动表情',
    '高清特写',
  ],
  landscape: [
    'award-winning landscape photography',
    'golden hour',
    'dramatic sky',
    'high detail',
    'atmospheric perspective',
    '风光摄影',
    '黄金时刻',
    'dramatic sky',
    '层次丰富',
    '大片质感',
  ],
  object: [
    'product photography',
    'studio lighting',
    'clean background',
    'highly detailed',
    'texture detail',
    'professional shot',
    '产品摄影',
    '棚拍',
    '细节丰富',
    '材质质感',
    '商业质感',
  ],
  food: [
    'food photography',
    'appetizing',
    'studio lighting',
    'shallow depth of field',
    'texture detail',
    'warm tones',
    '美食摄影',
    '令人垂涎',
    '暖色调',
    '质感丰富',
  ],
  fashion: [
    'fashion photography',
    'editorial',
    'runway',
    'dramatic lighting',
    'high contrast',
    'elegant',
    '时尚摄影',
    '高级感',
    '质感面料',
    '杂志大片',
  ],
  scifi: [
    'cyberpunk style',
    'neon lights',
    'futuristic',
    'highly detailed',
    '8k',
    'unreal engine',
    'concept art',
    '赛博朋克',
    '霓虹灯',
    '未来感',
    '超精细',
    '电影级',
  ],
});

// Universal fallback boosters when no category matches.
const _GENERIC_BOOST = Object.freeze([
  'high quality',
  'detailed',
  'sharp',
  'professional',
  'beautiful composition',
  'natural lighting',
  '高清',
  '精细',
  '自然光',
  '构图优美',
]);

/**
 * Enhance a short or thin prompt with quality/style keywords.
 *
 * Rules:
 *  - Enhancement is gated by KHY_IMAGE_GEN_ENHANCE_PROMPT (default: on).
 *    Set to 'off' / '0' / 'false' to disable.
 *  - Prompts that already contain depth keywords (from _DEPTH_KEYWORDS) are
 *    returned as-is — no redundant stacking.
 *  - Prompts ≤ 10 chars are always enhanced (they're too thin to carry intent).
 *  - Longer prompts are enhanced only if they lack any depth signal.
 *
 * @param {string} prompt
 * @returns {string} the original prompt, possibly with quality boosters appended
 */
function enhancePrompt(prompt) {
  if (_ENHANCE_GATE === 'off' || _ENHANCE_GATE === '0' || _ENHANCE_GATE === 'false') {
    return prompt;
  }
  const p = String(prompt || '').trim();
  if (!p || p.length > 60) {
    return p;
  } // very long prompts are already rich

  const lower = p.toLowerCase();

  // If already contains depth keywords → respect user's wording, no augmentation.
  if (_DEPTH_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))) {
    return p;
  }

  // Pick subject category — check scifi before landscape so "cyberpunk city"
  // doesn't get eaten by the "city" landscape keyword.
  const checkOrder = ['scifi', 'portrait', 'animal', 'landscape', 'food', 'fashion', 'object'];
  let category = 'generic';
  for (const cat of checkOrder) {
    const kws = _SUBJECT_HINTS[cat];
    if (kws && kws.some((kw) => lower.includes(kw.toLowerCase()))) {
      category = cat;
      break;
    }
  }

  const boosters = _CATEGORY_BOOST[category] || _GENERIC_BOOST;
  // Pick up to 4 boosters to keep the prompt readable
  const picked = boosters.slice(0, 4).join(', ');
  return `${p}, ${picked}`;
}

// Backend-specific fallbacks: only used when a caller passes a size that the
// backend genuinely can't handle at all.
const _SIZE_FALLBACKS = Object.freeze({
  sensenova: '2752x1536',
  agnes: '1024x1024',
  stepfun: '1024x1024',
  openai: '1024x1024',
  domestic: '1024x1024',
  sd_webui: '1024x1024',
});

function _normalizeSizeForBackend(size, backend) {
  const fallback = _SIZE_FALLBACKS[backend];
  if (!fallback || fallback === size) {
    return size;
  }
  return size;
}

// Fixed "auto" quality order — the precedence resolveBackend() uses when no
// explicit backend is pinned. Also the set of valid backend ids for the UI.
// Prioritized by cost-effectiveness + capability: SenseNova (free, infographics) >
//   Agnes (free, general) > StepFun (paid, fast) > OpenAI > domestic > sd_webui.
const AUTO_ORDER = ['sensenova', 'agnes', 'stepfun', 'openai', 'domestic', 'sd_webui'];

// Convenience default for the Agnes backend: when the user supplies only an API
// key (via the one-shot provisioner) we still know the public endpoint. Always
// overridable by KHY_IMAGE_GEN_AGNES_BASE_URL — no key/model is hardcoded.
const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_AGNES_MODEL = 'agnes-image-2.1-flash'; // legacy text-to-image default (gated; see agnesImageModel)
const DEFAULT_AGNES_EDIT_MODEL = 'agnes-image-2.0-flash'; // image-to-image / compositing

// agnes 文生图默认模型收敛到纯叶子 services/agnesImageModel(门控
// KHY_AGNES_UNIFIED_IMAGE_MODEL 默认开:文生图默认 = 官方唯一登记的 agnes-image-2.0-flash;
// 关 → 逐字节回退历史 agnes-image-2.1-flash)。显式 env / 参数覆盖始终优先。fail-soft。
function _defaultAgnesGenModel() {
  try {
    return require('./agnesImageModel').defaultAgnesGenModel(process.env);
  } catch {
    return DEFAULT_AGNES_MODEL;
  }
}

// 门控是否开(统一默认到官方 2.0-flash)。fail-soft:异常视作开(与默认一致)。
function _unifiedImageModelEnabled() {
  try {
    return require('./agnesImageModel').unifiedImageModelEnabled(process.env);
  } catch {
    return true;
  }
}

// 官方登记、可显式选中的 agnes 图像模型清单(2.0 默认在前、2.1 可选在后)。fail-soft。
function _knownAgnesImageModels() {
  try {
    return require('./agnesImageModel').knownAgnesImageModels();
  } catch {
    return [DEFAULT_AGNES_EDIT_MODEL, DEFAULT_AGNES_MODEL];
  }
}

// ── StepFun env helpers ──────────────────────────────────────────────────
// Supports both GATEWAY_IMAGE_GEN_* and KHY_IMAGE_GEN_* prefixes (like other
// backends), plus falls back to the shared STEPFUN_API_KEY / STEPFUN_API_ENDPOINT
// already configured for chat.
const DEFAULT_STEPFUN_BASE_URL = 'https://api.stepfun.com/v1';
const DEFAULT_STEPFUN_IMAGE_MODEL = 'step-image-edit-2';

function _stepfunEnv(name) {
  const v =
    process.env[`KHY_IMAGE_GEN_STEPFUN_${name}`] ??
    process.env[`GATEWAY_IMAGE_GEN_STEPFUN_${name}`];
  const s = v == null ? '' : String(v).trim();
  return s || '';
}

/** Resolve StepFun API key: explicit KHY/GATEWAY_IMAGE_GEN_STEPFUN_API_KEY wins, then
 *  fall back to the shared STEPFUN_API_KEY already configured for chat. */
function _stepfunApiKey() {
  const explicit = _stepfunEnv('API_KEY');
  if (explicit) {
    return explicit;
  }
  const shared = String(process.env.STEPFUN_API_KEY || '').trim();
  if (shared) {
    return shared;
  }
  return '';
}

function _stepfunBaseUrl() {
  const envBase = _stepfunEnv('BASE_URL');
  if (envBase) {
    return envBase.replace(/\/+$/, '');
  }
  return DEFAULT_STEPFUN_BASE_URL.replace(/\/+$/, '');
}

function _stepfunModel() {
  return _stepfunEnv('MODEL') || DEFAULT_STEPFUN_IMAGE_MODEL;
}

// ── SenseNova env helpers ──────────────────────────────────────────────────
// SenseNova U1 Fast: infographics-focused, OpenAI-compatible endpoint.
// Returns temporary URLs (1-hour expiry). No image input support.
const DEFAULT_SENSENOVA_BASE_URL = 'https://token.sensenova.cn/v1';
const DEFAULT_SENSENOVA_IMAGE_MODEL = 'sensenova-u1-fast';

function _sensenovaEnv(name) {
  const v =
    process.env[`KHY_IMAGE_GEN_SENSENOVA_${name}`] ??
    process.env[`GATEWAY_IMAGE_GEN_SENSENOVA_${name}`];
  const s = v == null ? '' : String(v).trim();
  return s || '';
}

/** Resolve SenseNova API key: explicit KHY/GATEWAY_IMAGE_GEN_SENSENOVA_API_KEY wins,
 *  then fall back to the shared SENSENOVA_API_KEY already configured for chat. */
function _sensenovaApiKey() {
  const explicit = _sensenovaEnv('API_KEY');
  if (explicit) {
    return explicit;
  }
  const shared = String(process.env.SENSENOVA_API_KEY || '').trim();
  if (shared) {
    return shared;
  }
  return '';
}

function _sensenovaBaseUrl() {
  const envBase = _sensenovaEnv('BASE_URL');
  if (envBase) {
    return envBase.replace(/\/+$/, '');
  }
  return DEFAULT_SENSENOVA_BASE_URL.replace(/\/+$/, '');
}

function _sensenovaModel() {
  return _sensenovaEnv('MODEL') || DEFAULT_SENSENOVA_IMAGE_MODEL;
}

// ── env helpers ─────────────────────────────────────────────────────
// Honor both GATEWAY_IMAGE_* and KHY_IMAGE_* prefixes for consistency with the
// existing GATEWAY_IMAGE_SMALL_TASK_TIMEOUT_MS || KHY_IMAGE_SMALL_TASK_TIMEOUT_MS
// convention in aiGateway.js.
function _env(name) {
  const v = process.env[`KHY_IMAGE_GEN_${name}`] ?? process.env[`GATEWAY_IMAGE_GEN_${name}`];
  const s = v == null ? '' : String(v).trim();
  return s || '';
}

function _timeoutMs() {
  const raw = parseInt(_env('TIMEOUT_MS'), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Bridge fallback: when no dedicated KHY_IMAGE_GEN_AGNES_API_KEY is set, borrow an
 * already-configured *chat* provider whose endpoint host is a known image-serving
 * host (imageGenPoolBridge whitelist). Lets a user who configured agnes only as a
 * chat provider (key in apiKeyPool, not in KHY_IMAGE_GEN_* env) still generate images.
 *
 * The pure leaf decides *which* provider (host-whitelist); the actual key + endpoint
 * come from apiKeyPool.pick() here (runtime secret stays out of the leaf). Gated by
 * KHY_IMAGE_GEN_POOL_BRIDGE (default-on). Fail-soft: any error / gate-off → null, so
 * every consumer byte-reverts to today's env-only behaviour.
 *
 * @returns {{ key: string, endpoint: string } | null}
 */
function _agnesKeyFromPool() {
  try {
    const bridge = require('./imageGenPoolBridge');
    if (!bridge.bridgeEnabled(process.env)) {
      return null;
    }

    const registry = require('./customProviderRegistry');
    const pool = require('./apiKeyPool');
    const providers = (registry.listProviders() || [])
      .map((p) => ({ poolKey: p && p.poolKey, endpoint: p && p.endpoint }))
      .filter((p) => p.poolKey);

    const picked = bridge.pickImageProviderFromPool({ providers });
    if (!picked) {
      return null;
    }

    const sel = pool.pick(picked.poolKey);
    if (!sel || !sel.key) {
      return null;
    }
    // Prefer the live endpoint from the selected key, else the registry endpoint.
    const endpoint = String(sel.endpoint || picked.endpoint || '').replace(/\/+$/, '');
    return { key: sel.key, endpoint };
  } catch {
    return null;
  }
}

/** Resolve the Agnes base URL (env override, else a bridged pool endpoint, else the public default). */
function _agnesBaseUrl() {
  const envBase = _env('AGNES_BASE_URL');
  if (envBase) {
    return envBase.replace(/\/+$/, '');
  }
  const bridged = _agnesKeyFromPool();
  if (bridged && bridged.endpoint) {
    return bridged.endpoint.replace(/\/+$/, '');
  }
  return DEFAULT_AGNES_BASE_URL.replace(/\/+$/, '');
}

/** True when the cross-key rotation gate is on (default-on). Fail-soft: on → default. */
function _keyRotateEnabled() {
  try {
    const raw = process.env.KHY_IMAGE_GEN_KEY_ROTATE;
    const v = String(raw == null ? '' : raw)
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(v);
  } catch {
    return true;
  }
}

/**
 * Enumerate the *available* (non-cooldown) pool keys usable for image gen, across
 * every chat provider whose endpoint host is whitelisted (imageGenPoolBridge). Each
 * entry carries its keyId so a rejecting key can be reported via apiKeyPool.markFailure
 * and skipped on the next attempt. Ordered deterministically (by provider, then pool
 * order). Gate-off / any error → []. Zero throw.
 *
 * @returns {Array<{ key: string, endpoint: string, keyId: string, poolKey: string }>}
 */
function _agnesPoolCandidates() {
  try {
    const bridge = require('./imageGenPoolBridge');
    if (!bridge.bridgeEnabled(process.env)) {
      return [];
    }

    const registry = require('./customProviderRegistry');
    const pool = require('./apiKeyPool');
    const providers = (registry.listProviders() || [])
      .map((p) => ({ poolKey: p && p.poolKey, endpoint: p && p.endpoint }))
      .filter((p) => p.poolKey);

    const hits = bridge.listImageProvidersFromPool({ providers });
    const out = [];
    for (const hit of hits) {
      let keys = [];
      try {
        keys = pool.listAvailableKeys(hit.poolKey) || [];
      } catch {
        keys = [];
      }
      for (const k of keys) {
        if (!k || !k.key || !k.keyId) {
          continue;
        }
        const endpoint = String(k.endpoint || hit.endpoint || '').replace(/\/+$/, '');
        out.push({ key: k.key, endpoint, keyId: k.keyId, poolKey: hit.poolKey });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Which backends have the minimum env to operate. */
function backendStatus() {
  return {
    openai: Boolean(_env('OPENAI_BASE_URL') && _env('OPENAI_API_KEY')),
    // SenseNova: shared SENSENOVA_API_KEY (from chat config) or explicit image-gen key.
    sensenova: Boolean(_sensenovaApiKey()),
    // Agnes ships a known public endpoint, so an API key alone is enough. When no
    // dedicated KHY_IMAGE_GEN_AGNES_API_KEY is set, fall back to a chat provider's
    // agnes key bridged from apiKeyPool (imageGenPoolBridge, gated/fail-soft).
    agnes: Boolean(_env('AGNES_API_KEY') || _agnesKeyFromPool()),
    // StepFun: shared STEPFUN_API_KEY (from chat config) or explicit image-gen key.
    stepfun: Boolean(_stepfunApiKey()),
    domestic: Boolean(_env('DOMESTIC_BASE_URL') && _env('DOMESTIC_API_KEY')),
    sd_webui: Boolean(_env('SD_BASE_URL')),
  };
}

/** Backends capable of image-to-image / editing (not just text-to-image). */
function backendSupportsEdit(backend) {
  return backend === 'agnes' || backend === 'stepfun';
  // SenseNova U1 Fast does NOT support image input (text-to-image only).
}

/**
 * Enumerate the image models each *active* backend exposes, for the model
 * catalog graph (modelCatalogGraph.js). One entry per (backend, model); model
 * names are resolved from the same env the generators use, so nothing is
 * hardcoded here. Never makes a network call. `supportsEdit` marks backends
 * that also do image-to-image.
 *
 * These models live OUTSIDE custom_providers.json (their own KHY_IMAGE_GEN_*
 * namespace), so this is the ONLY way the "by-capability" view can surface them.
 * @returns {Array<{backend:string, model:string, capability:'image', supportsEdit:boolean}>}
 */
function catalogModels() {
  const status = backendStatus();
  const out = [];
  if (status.sensenova) {
    // SenseNova U1 Fast: infographics-focused, text-to-image only (no img2img).
    const model = _sensenovaModel();
    out.push({ backend: 'sensenova', model, capability: 'image', supportsEdit: false });
  }
  if (status.openai) {
    out.push({
      backend: 'openai',
      model: _env('OPENAI_MODEL') || 'openai-image',
      capability: 'image',
      supportsEdit: false,
    });
  }
  if (status.agnes) {
    // Agnes exposes two documented, selectable image models (2.0-flash unified default
    // + 2.1-flash upgraded); both do text-to-image AND image-to-image. An explicit
    // KHY_IMAGE_GEN_AGNES_MODEL override pins the catalog to that one id (historical shape).
    // Otherwise, gate-on lists BOTH known ids so 2.1 stays first-class; gate-off byte-reverts
    // to the legacy "gen-default + edit-default (if different)" pair.
    const explicit = _env('AGNES_MODEL');
    const editModel = _env('AGNES_EDIT_MODEL') || DEFAULT_AGNES_EDIT_MODEL;
    const models = [];
    if (explicit) {
      models.push(explicit);
    } else if (_unifiedImageModelEnabled()) {
      models.push(..._knownAgnesImageModels());
    } else {
      models.push(_defaultAgnesGenModel());
    }
    if (editModel && !models.includes(editModel)) {
      models.push(editModel);
    }
    for (const model of models) {
      out.push({ backend: 'agnes', model, capability: 'image', supportsEdit: true });
    }
  }
  if (status.stepfun) {
    // StepFun Image Edit 2: single model supporting both text-to-image and image editing.
    // Supports: step-image-edit-2 (text-to-image, image-to-image).
    const model = _stepfunModel();
    out.push({ backend: 'stepfun', model, capability: 'image', supportsEdit: true });
  }
  if (status.domestic) {
    out.push({
      backend: 'domestic',
      model: _env('DOMESTIC_MODEL') || 'domestic-image',
      capability: 'image',
      supportsEdit: false,
    });
  }
  if (status.sd_webui) {
    out.push({
      backend: 'sd_webui',
      model: 'stable-diffusion-webui',
      capability: 'image',
      supportsEdit: false,
    });
  }
  return out;
}

/** True when at least one image backend is usable. */
function isAnyBackendConfigured() {
  const s = backendStatus();
  return s.sensenova || s.openai || s.agnes || s.stepfun || s.domestic || s.sd_webui;
}

/**
 * Resolve which backend to use. Precedence:
 *   1. an explicit caller override (e.g. a per-user UI selection),
 *   2. the KHY_IMAGE_GEN_BACKEND env pin,
 *   3. auto-detect by the fixed quality order sensenova > agnes > stepfun > openai > domestic > sd_webui.
 * An empty/falsy override or env value means "auto".
 * @param {string} [override] explicit backend id from a caller (UI selection)
 * @returns {string|null} backend id, or null if none configured
 */
function resolveBackend(override) {
  const picked = String(override || '')
    .trim()
    .toLowerCase();
  const status = backendStatus();
  // Honor an explicit override even if mis-set, so generate() can report a clear error.
  if (picked && picked !== 'auto') {
    return status[picked] ? picked : picked;
  }
  const explicit = _env('BACKEND').toLowerCase();
  if (explicit) {
    return status[explicit] ? explicit : explicit;
  } // honor explicit even if mis-set
  for (const id of AUTO_ORDER) {
    if (status[id]) {
      return id;
    }
  }
  return null;
}

/** Human-readable list of the env each backend needs (for the no-backend error). */
function backendHelpText() {
  return [
    '未检测到任何图像生成后端。请配置以下任一组环境变量后重试：',
    '  SenseNova:   SENSENOVA_API_KEY（自动检测；专供信息图 Infographics，不支持图生图）',
    '  OpenAI 兼容: KHY_IMAGE_GEN_OPENAI_BASE_URL, KHY_IMAGE_GEN_OPENAI_API_KEY, KHY_IMAGE_GEN_OPENAI_MODEL',
    '  StepFun 阶跃星辰: STEPFUN_API_KEY（自动检测，无需额外配置；可选 KHY_IMAGE_GEN_STEPFUN_MODEL 切换模型）',
    '  Agnes AI:   KHY_IMAGE_GEN_AGNES_API_KEY (可选 KHY_IMAGE_GEN_AGNES_BASE_URL / _MODEL / _EDIT_MODEL；支持文生图与图改图)',
    '  国内 API:   KHY_IMAGE_GEN_DOMESTIC_BASE_URL, KHY_IMAGE_GEN_DOMESTIC_API_KEY, KHY_IMAGE_GEN_DOMESTIC_MODEL',
    '              (可选 KHY_IMAGE_GEN_DOMESTIC_RESPONSE_PATH 指定响应取图路径, 如 data.0.b64_json 或 output.results.0.url)',
    '  本地 SD:    KHY_IMAGE_GEN_SD_BASE_URL (如 http://127.0.0.1:7860)',
    '可用 KHY_IMAGE_GEN_BACKEND=sensenova|openai|stepfun|agnes|domestic|sd_webui 显式选择后端。',
  ].join('\n');
}

// ── HTTP ────────────────────────────────────────────────────────────

/** A fetch dispatcher honoring the active HTTP proxy, if any (undici ProxyAgent). */
const _proxyDispatcher = require('../utils/proxyDispatcherAgent');

async function _postJson(url, body, headers) {
  const res = await _proxyDispatcher.fetchWithProxyFallback(
    (signal, dispatcher) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      }),
    { timeoutMs: _timeoutMs(), url, operation: 'image-generate' }
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const snippet = text ? text.slice(0, 400) : '(empty body)';
    // Attach the HTTP status (additive) so callers can branch on 401/403/429 to
    // report a pool key as failed (apiKeyPool.markFailure) and rotate to the next.
    const err = new Error(`HTTP ${res.status} ${res.statusText} — ${snippet}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Download a remote image URL and return base64 (for backends that return URLs). */
async function _fetchUrlToBase64(url) {
  const res = await _proxyDispatcher.fetchWithProxyFallback(
    (signal, dispatcher) => fetch(url, { signal, ...(dispatcher ? { dispatcher } : {}) }),
    { timeoutMs: _timeoutMs(), url, operation: 'image-download' }
  );
  if (!res.ok) {
    throw new Error(`image download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

/** Read a dotted path like "data.0.b64_json" out of a response object. */
function _readPath(obj, dottedPath) {
  if (!dottedPath) {
    return undefined;
  }
  let cur = obj;
  for (const seg of String(dottedPath).split('.')) {
    if (cur == null) {
      return undefined;
    }
    const key = /^\d+$/.test(seg) ? Number(seg) : seg;
    cur = cur[key];
  }
  return cur;
}

// ── backend adapters ────────────────────────────────────────────────
// Each returns { images: [{ base64 }], model } — base64 is raw (no data URL).

async function _generateOpenAiCompatible({ prompt, size, n, modelOverride }) {
  const baseUrl = _env('OPENAI_BASE_URL').replace(/\/+$/, '');
  const apiKey = _env('OPENAI_API_KEY');
  const model = modelOverride || _env('OPENAI_MODEL');
  if (!baseUrl || !apiKey) {
    throw new Error('OpenAI 兼容后端缺少 BASE_URL 或 API_KEY');
  }
  const url = `${baseUrl}/images/generations`;
  const body = { prompt, size, n, response_format: 'b64_json' };
  if (model) {
    body.model = model;
  }
  const json = await _postJson(url, body, { authorization: `Bearer ${apiKey}` });
  const data = (json && json.data) || [];
  const images = [];
  for (const item of data) {
    if (item && item.b64_json) {
      images.push({ base64: item.b64_json });
    } else if (item && item.url) {
      images.push({ base64: await _fetchUrlToBase64(item.url) });
    }
  }
  if (!images.length) {
    throw new Error('OpenAI 兼容后端未返回图像数据');
  }
  return { images, model: model || (json && json.model) || null };
}

async function _generateStepFun({ prompt, size, images, modelOverride }) {
  const isEdit = Array.isArray(images) && images.length > 0;
  const model = modelOverride || _stepfunModel();
  const baseUrl = _stepfunBaseUrl();
  const apiKey = _stepfunApiKey();
  if (!apiKey) {
    throw new Error('StepFun 后端缺少 API_KEY（STEPFUN_API_KEY）');
  }

  // StepFun Image Edit 2: single model handles both text-to-image and image editing.
  // Endpoint: POST /v1/images/generations (OpenAI-compatible shape + StepFun extras).
  const url = `${baseUrl}/images/generations`;
  const body = {
    model,
    prompt,
    response_format: 'b64_json',
    // StepFun-specific tuning (safe defaults from docs)
    cfg_scale: 1.0,
    steps: 8,
  };
  if (isEdit) {
    body.image = images;
  }
  const json = await _postJson(url, body, { authorization: `Bearer ${apiKey}` });
  const data = (json && json.data) || [];
  const out = [];
  for (const item of data) {
    if (item && item.b64_json) {
      out.push({ base64: item.b64_json });
    } else if (item && item.url) {
      out.push({ base64: await _fetchUrlToBase64(item.url) });
    }
  }
  if (!out.length) {
    throw new Error('StepFun 后端未返回图像数据');
  }
  return { images: out, model };
}

async function _generateSenseNova({ prompt, size, n, modelOverride }) {
  // SenseNova U1 Fast: infographics-focused, text-to-image only.
  // Returns temporary URLs (1-hour expiry) — we download and convert to base64
  // so the caller gets a persistent copy.
  const model = modelOverride || _sensenovaModel();
  const baseUrl = _sensenovaBaseUrl();
  const apiKey = _sensenovaApiKey();
  if (!apiKey) {
    throw new Error('SenseNova 后端缺少 API_KEY（SENSENOVA_API_KEY）');
  }

  const url = `${baseUrl}/images/generations`;
  const body = {
    model,
    prompt,
    n: Math.max(1, Math.min(4, n || 1)),
  };
  if (size) {
    body.size = size;
  }

  const json = await _postJson(url, body, { authorization: `Bearer ${apiKey}` });
  const data = (json && json.data) || [];
  const out = [];
  for (const item of data) {
    if (item && item.url) {
      // SenseNova URLs expire in 1 hour — download immediately to preserve the image.
      out.push({ base64: await _fetchUrlToBase64(item.url) });
    }
  }
  if (!out.length) {
    throw new Error('SenseNova 后端未返回图像数据');
  }
  return { images: out, model };
}

/** True when the given HTTP status means "this credential was rejected / throttled". */
function _isKeyRejection(status) {
  return status === 401 || status === 403 || status === 429;
}

async function _generateAgnes({ prompt, size, images, modelOverride }) {
  const isEdit = Array.isArray(images) && images.length > 0;
  // text-to-image and image-to-image use different model defaults but the same
  // endpoint; both are env-overridable, and a caller override (UI selection) wins.
  const model =
    modelOverride ||
    (isEdit
      ? _env('AGNES_EDIT_MODEL') || _env('AGNES_MODEL') || DEFAULT_AGNES_EDIT_MODEL
      : _env('AGNES_MODEL') || _defaultAgnesGenModel());

  // Build the request body once (identical across every key attempt). Agnes quirk:
  // `response_format` and the img2img `image[]` array MUST live in `extra_body` — a
  // top-level `response_format` returns HTTP 400. The request style is env-switchable
  // in case the upstream contract changes, but defaults to the documented shape.
  const style = (_env('AGNES_REQUEST_STYLE') || 'extra_body').toLowerCase();
  const body = { model, prompt, size };
  const extra = { response_format: 'b64_json' };
  if (isEdit) {
    extra.image = images;
  }
  if (style === 'top_level') {
    body.response_format = 'b64_json';
    if (isEdit) {
      body.image = images;
    }
  } else {
    body.extra_body = extra;
  }

  // One POST + parse against a specific key/endpoint. Bubbles up the HTTP status
  // (via err.status from _postJson) so the caller can rotate on 401/403/429.
  const attempt = async (apiKey, baseUrl) => {
    const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
    const json = await _postJson(url, body, { authorization: `Bearer ${apiKey}` });
    const data = (json && json.data) || [];
    const out = [];
    for (const item of data) {
      if (item && item.b64_json) {
        out.push({ base64: item.b64_json });
      } else if (item && item.url) {
        out.push({ base64: await _fetchUrlToBase64(item.url) });
      }
    }
    if (!out.length) {
      throw new Error('Agnes 后端未返回图像数据');
    }
    return { images: out, model };
  };

  // 1) Explicit env key stays first-priority and NEVER rotates (byte-identical to
  //    today's behaviour). A dedicated image-gen key is the operator's own choice.
  const envKey = _env('AGNES_API_KEY');
  if (envKey) {
    return attempt(envKey, _agnesBaseUrl());
  }

  // 2) No env key — borrow a chat provider's agnes credential from apiKeyPool.
  //    When rotation is on, walk every available (non-cooldown) whitelisted key:
  //    on a key rejection (401/403/429) mark it failed (cooldown) and try the next;
  //    on success mark it healthy. When all are exhausted, throw NO_USABLE_KEY so the
  //    tool layer can offer to configure a fresh key.
  if (_keyRotateEnabled()) {
    const pool = (() => {
      try {
        return require('./apiKeyPool');
      } catch {
        return null;
      }
    })();
    const candidates = _agnesPoolCandidates();
    if (pool && candidates.length) {
      let lastErr = null;
      for (const cand of candidates) {
        try {
          const result = await attempt(cand.key, cand.endpoint || _agnesBaseUrl());
          try {
            pool.markSuccess(cand.keyId);
          } catch {
            /* fail-soft */
          }
          return result;
        } catch (e) {
          lastErr = e;
          const status = e && typeof e.status === 'number' ? e.status : null;
          if (status && _isKeyRejection(status)) {
            try {
              pool.markFailure(cand.keyId, status, e.message);
            } catch {
              /* fail-soft */
            }
            continue; // rejected/throttled → try the next key
          }
          // Non-credential error (timeout, 400, network) → don't burn other keys on it.
          throw e;
        }
      }
      // Every whitelisted key was rejected/cooled down.
      const exhausted = new Error(
        `Agnes 图像生成没能完成:已配置的图像生成 key 都不可用${lastErr ? ` — ${lastErr.message}` : ''}`
      );
      exhausted.code = 'NO_USABLE_KEY';
      if (lastErr && typeof lastErr.status === 'number') {
        exhausted.status = lastErr.status;
      }
      exhausted.cause = lastErr || undefined;
      throw exhausted;
    }
  }

  // 3) Rotation off (or no pool candidates) — byte-revert to "pick once, throw on
  //    empty". Preserves today's behaviour when the gate is closed.
  const apiKey = (_agnesKeyFromPool() || {}).key || '';
  if (!apiKey) {
    throw new Error('Agnes 后端缺少 AGNES_API_KEY');
  }
  return attempt(apiKey, _agnesBaseUrl());
}

async function _generateDomestic({ prompt, negativePrompt, size, n, seed, modelOverride }) {
  const baseUrl = _env('DOMESTIC_BASE_URL').replace(/\/+$/, '');
  const apiKey = _env('DOMESTIC_API_KEY');
  const model = modelOverride || _env('DOMESTIC_MODEL');
  const responsePath = _env('DOMESTIC_RESPONSE_PATH'); // e.g. data.0.b64_json or output.results.0.url
  const authHeader = _env('DOMESTIC_AUTH_HEADER') || 'authorization';
  const authPrefix = _env('DOMESTIC_AUTH_PREFIX') || 'Bearer ';
  if (!baseUrl || !apiKey) {
    throw new Error('国内后端缺少 BASE_URL 或 API_KEY');
  }
  // OpenAI-compatible-first request shape; many domestic gateways accept it.
  const url = baseUrl.endsWith('/images/generations') ? baseUrl : `${baseUrl}/images/generations`;
  const body = { prompt, size, n, response_format: 'b64_json' };
  if (model) {
    body.model = model;
  }
  if (negativePrompt) {
    body.negative_prompt = negativePrompt;
  }
  if (Number.isFinite(seed)) {
    body.seed = seed;
  }
  const json = await _postJson(url, body, { [authHeader]: `${authPrefix}${apiKey}` });

  const images = [];
  if (responsePath) {
    // Single explicit path → may be a string (b64 or url) or an array of either.
    const picked = _readPath(json, responsePath);
    const items = Array.isArray(picked) ? picked : [picked];
    for (const it of items) {
      if (!it) {
        continue;
      }
      const s = typeof it === 'string' ? it : it.b64_json || it.url || '';
      if (!s) {
        continue;
      }
      if (/^https?:\/\//i.test(s)) {
        images.push({ base64: await _fetchUrlToBase64(s) });
      } else {
        images.push({ base64: s });
      }
    }
  } else {
    // Default to OpenAI-compatible data[] shape.
    for (const item of (json && json.data) || []) {
      if (item && item.b64_json) {
        images.push({ base64: item.b64_json });
      } else if (item && item.url) {
        images.push({ base64: await _fetchUrlToBase64(item.url) });
      }
    }
  }
  if (!images.length) {
    throw new Error(
      '国内后端未返回可解析的图像数据（可设置 KHY_IMAGE_GEN_DOMESTIC_RESPONSE_PATH 指定取图路径）'
    );
  }
  return { images, model: model || null };
}

async function _generateSdWebui({ prompt, negativePrompt, size, n, seed, modelOverride }) {
  const baseUrl = _env('SD_BASE_URL').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('本地 SD WebUI 缺少 SD_BASE_URL');
  }
  const [w, h] = String(size || _SIZE_FALLBACKS.sd_webui)
    .split('x')
    .map((x) => parseInt(x, 10));
  const steps = parseInt(_env('SD_STEPS'), 10);
  const sampler = _env('SD_SAMPLER');
  const body = {
    prompt,
    negative_prompt: negativePrompt || '',
    width: Number.isFinite(w) ? w : 1024,
    height: Number.isFinite(h) ? h : 1024,
    batch_size: n || 1,
    steps: Number.isFinite(steps) ? steps : 20,
  };
  if (sampler) {
    body.sampler_name = sampler;
  }
  if (Number.isFinite(seed)) {
    body.seed = seed;
  }
  const json = await _postJson(`${baseUrl}/sdapi/v1/txt2img`, body, {});
  const images = ((json && json.images) || []).map((b64) => ({ base64: b64 }));
  if (!images.length) {
    throw new Error('本地 SD WebUI 未返回图像数据');
  }
  return { images, model: modelOverride || 'stable-diffusion-webui' };
}

/**
 * Generate images. Returns { backend, model, images:[{base64}], size, n }.
 * Throws on no-backend / backend error (caller maps to a tool result).
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.negativePrompt]
 * @param {string} [opts.size]
 * @param {number} [opts.n]
 * @param {number} [opts.seed]
 * @param {string[]} [opts.images] input image refs (public URLs or data: URIs)
 *                                 for image-to-image / multi-image compositing.
 *                                 Only honored by edit-capable backends (agnes).
 * @param {string} [opts.backend] explicit backend override (UI selection); ''/'auto' = auto.
 * @param {string} [opts.model]   explicit model override (UI selection) for that backend.
 */
async function generate({ prompt, negativePrompt, size, n, seed, images, backend, model } = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('prompt 不能为空');
  }
  const resolvedBackend = resolveBackend(backend);
  if (!resolvedBackend) {
    const e = new Error(backendHelpText());
    e.code = 'NO_BACKEND';
    throw e;
  }
  const inputImages = Array.isArray(images) ? images.filter(Boolean).map(String) : [];
  if (inputImages.length && !backendSupportsEdit(resolvedBackend)) {
    const e = new Error(
      `当前图像后端 "${resolvedBackend}" 不支持图改图（img2img）。请使用 Agnes 或 StepFun 后端：` +
        'KHY_IMAGE_GEN_AGNES_API_KEY 或 STEPFUN_API_KEY（并设 KHY_IMAGE_GEN_BACKEND=agnes|stepfun）。'
    );
    e.code = 'EDIT_UNSUPPORTED';
    throw e;
  }
  const modelOverride = model ? String(model).trim() : '';
  const explicitSize = size ? String(size).trim() : '';
  const rawPrompt = String(prompt);
  const resolvedSize = resolveSize(rawPrompt, resolvedBackend, explicitSize);
  const args = {
    prompt: enhancePrompt(rawPrompt),
    negativePrompt: negativePrompt ? String(negativePrompt) : '',
    size: resolvedSize,
    n: Math.max(1, Math.min(4, parseInt(n, 10) || 1)),
    seed: Number.isFinite(seed) ? seed : undefined,
    images: inputImages,
    modelOverride: modelOverride || undefined,
  };
  let out;
  if (resolvedBackend === 'openai') {
    out = await _generateOpenAiCompatible(args);
  } else if (resolvedBackend === 'sensenova') {
    out = await _generateSenseNova(args);
  } else if (resolvedBackend === 'stepfun') {
    out = await _generateStepFun(args);
  } else if (resolvedBackend === 'agnes') {
    out = await _generateAgnes(args);
  } else if (resolvedBackend === 'domestic') {
    out = await _generateDomestic(args);
  } else if (resolvedBackend === 'sd_webui') {
    out = await _generateSdWebui(args);
  } else {
    throw new Error(`未知的图像后端: ${resolvedBackend}`);
  }
  return {
    backend: resolvedBackend,
    model: out.model || null,
    images: out.images,
    size: args.size,
    n: args.n,
    edited: inputImages.length > 0,
  };
}

module.exports = {
  generate,
  resolveBackend,
  resolveSize,
  enhancePrompt,
  backendStatus,
  backendSupportsEdit,
  catalogModels,
  isAnyBackendConfigured,
  backendHelpText,
  AUTO_ORDER,
  // internals exposed for unit tests (no network)
  __testHooks: { _readPath, _env, _timeoutMs, _agnesBaseUrl, enhancePrompt },
};
