'use strict';

/**
 * agnesProvisioner — one API key → all four Agnes capabilities wired at once.
 *
 * Agnes AI (Sapiens) exposes four models that KHY routes to THREE different
 * subsystems, each with its own env namespace:
 *
 *   model                    capability            subsystem (env namespace)
 *   ────────────────────────────────────────────────────────────────────────
 *   agnes-2.0-flash          chat / code / agent   chat provider pool
 *                                                  (customProviderRegistrar →
 *                                                   GATEWAY_API_POOL_* + PROXY_MODEL_ROUTE_MAP)
 *   agnes-image-2.0-flash    text-to-image +       imageGenService
 *                            image-to-image        (KHY_IMAGE_GEN_AGNES_*)
 *                            (unified default)
 *   agnes-image-2.1-flash    text-to-image +       imageGenService (upgraded,
 *                            image-to-image        selectable via model override)
 *   agnes-video-v2.0         text/image-to-video   videoGenService
 *                                                  (KHY_VIDEO_GEN_AGNES_*)
 *
 * The chat model is the ONLY one that goes through the gateway proxy
 * (which relays chat/messages/responses/models). Image and video are async
 * REST surfaces the proxy does not relay, so they MUST NOT be added to the
 * chat preset's PROXY_MODEL_ROUTE_MAP — they are wired purely via their own
 * service env vars.
 *
 * Design rules honoured here:
 *   - 零硬编码 (zero-hardcoding): the API key is always supplied by the caller;
 *     base URLs / model IDs come from the chat preset and the services' own
 *     env-overridable defaults — nothing is baked in here. Every default can be
 *     overridden via opts or the existing KHY_*_AGNES_* env vars.
 *   - 状态透明 (state transparency): the return value reports exactly which
 *     capabilities were wired, the env keys written, and — for image — which
 *     backend actually resolves active afterwards.
 *   - Non-destructive: image backend selection is NOT forced unless the caller
 *     asks (forceImageBackend), so provisioning Agnes never silently steals an
 *     already-configured OpenAI image backend.
 */

const registrar = require('./customProviderRegistrar');
const { writeEnvPatch } = require('./gatewayEnvFile');

/** Pull the built-in Agnes chat preset (endpoint + chat model) — single source. */
function _agnesChatPreset() {
  const presets = registrar.getPresets();
  return presets.find(p => p.id === 'agnes') || null;
}

/**
 * Provision some or all Agnes capabilities from a single API key.
 *
 * @param {object} opts
 * @param {string}  opts.apiKey            required — the Agnes API key
 * @param {boolean} [opts.chat=true]       wire agnes-2.0-flash as a chat provider
 * @param {boolean} [opts.image=true]      wire image generation/editing backend
 * @param {boolean} [opts.video=true]      wire video generation backend
 * @param {string}  [opts.displayName]     chat provider display name (default from preset)
 * @param {string}  [opts.poolKey='agnes'] chat provider internal id
 * @param {string}  [opts.tier]            optional capability tier for chat models (T0-T3)
 * @param {boolean} [opts.forceImageBackend=false] also set KHY_IMAGE_GEN_BACKEND=agnes
 * @param {boolean} [opts.ensureInit=false] init the key pool before registering (HTTP entry)
 * @returns {{
 *   apiKeyMasked:string,
 *   chat:  {wired:boolean, poolKey?:string, models?:string[], endpoint?:string, error?:string},
 *   image: {wired:boolean, envKeys?:string[], backendActive?:string|null, error?:string},
 *   video: {wired:boolean, envKeys?:string[], error?:string},
 *   envKeysWritten:string[]
 * }}
 */
function provisionAgnes(opts = {}) {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('Agnes API Key 不能为空');

  const wantChat = opts.chat !== false;
  const wantImage = opts.image !== false;
  const wantVideo = opts.video !== false;

  const preset = _agnesChatPreset();
  const summary = {
    apiKeyMasked: _mask(apiKey),
    chat: { wired: false },
    image: { wired: false },
    video: { wired: false },
    envKeysWritten: [],
  };

  // ── 1. Chat provider (agnes-2.0-flash) — reuse the shared registrar ────────
  if (wantChat) {
    try {
      const result = registrar.registerCustomProvider({
        displayName: String(opts.displayName || (preset && preset.name) || 'Agnes AI').trim(),
        poolKey: String(opts.poolKey || (preset && preset.id) || 'agnes').trim(),
        endpoint: (preset && preset.endpoint) || 'https://apihub.agnes-ai.com/v1',
        keyInput: apiKey,
        defaultModel: (preset && preset.defaultModel) || 'agnes-2.0-flash',
        extraModels: preset && Array.isArray(preset.models)
          ? preset.models.filter(m => m !== preset.defaultModel)
          : [],
        tier: opts.tier,
        ensureInit: !!opts.ensureInit,
      });
      summary.chat = {
        wired: true,
        poolKey: result.poolKey,
        models: result.models,
        endpoint: result.endpoint,
        keyCount: result.keyCount,
        tier: result.tier || '',
      };
    } catch (e) {
      summary.chat = { wired: false, error: e.message };
    }
  }

  // ── 2. Image backend (text-to-image + image-to-image) ─────────────────────
  // Only the API key is written; base URL and model IDs use imageGenService's
  // env-overridable defaults (agnes-image-2.1-flash gen / agnes-image-2.0-flash
  // edit). The proxy does not relay images, so nothing touches PROXY_MODEL_ROUTE_MAP.
  if (wantImage) {
    try {
      const imgEnv = { KHY_IMAGE_GEN_AGNES_API_KEY: apiKey };
      if (opts.forceImageBackend) imgEnv.KHY_IMAGE_GEN_BACKEND = 'agnes';
      writeEnvPatch(imgEnv);
      const imageGenService = require('./imageGenService');
      summary.image = {
        wired: true,
        envKeys: Object.keys(imgEnv),
        backendActive: imageGenService.resolveBackend(),
        supportsEdit: imageGenService.backendSupportsEdit('agnes'),
      };
      summary.envKeysWritten.push(...Object.keys(imgEnv));
    } catch (e) {
      summary.image = { wired: false, error: e.message };
    }
  }

  // ── 3. Video backend (text/image-to-video, async) ─────────────────────────
  if (wantVideo) {
    try {
      const vidEnv = { KHY_VIDEO_GEN_AGNES_API_KEY: apiKey };
      writeEnvPatch(vidEnv);
      const videoGenService = require('./videoGenService');
      summary.video = {
        wired: true,
        envKeys: Object.keys(vidEnv),
        backendActive: videoGenService.resolveBackend(),
      };
      summary.envKeysWritten.push(...Object.keys(vidEnv));
    } catch (e) {
      summary.video = { wired: false, error: e.message };
    }
  }

  return summary;
}

/** Mask an API key for state-transparency reporting (never log the raw key). */
function _mask(key) {
  const s = String(key || '');
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Human-readable one-shot summary of a provisionAgnes() result. */
function formatProvisionSummary(summary) {
  const lines = [];
  lines.push(`Agnes 一键置备 (key ${summary.apiKeyMasked}):`);
  if (summary.chat.wired) {
    lines.push(`  ✓ 对话/代码/Agent → ${summary.chat.models.join(', ')} (provider: ${summary.chat.poolKey})`);
  } else if (summary.chat.error) {
    lines.push(`  ✗ 对话置备失败: ${summary.chat.error}`);
  }
  if (summary.image.wired) {
    const active = summary.image.backendActive === 'agnes' ? '已激活' : `当前激活后端=${summary.image.backendActive || '无'}`;
    lines.push(`  ✓ 文生图 + 图改图 → agnes-image-2.0-flash (默认) / agnes-image-2.1-flash (升级版可选) (${active})`);
  } else if (summary.image.error) {
    lines.push(`  ✗ 图像置备失败: ${summary.image.error}`);
  }
  if (summary.video.wired) {
    lines.push('  ✓ 文生视频/图生视频/关键帧 → agnes-video-v2.0');
  } else if (summary.video.error) {
    lines.push(`  ✗ 视频置备失败: ${summary.video.error}`);
  }
  return lines.join('\n');
}

module.exports = {
  provisionAgnes,
  formatProvisionSummary,
  __testHooks: { _mask, _agnesChatPreset },
};
