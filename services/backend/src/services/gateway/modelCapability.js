'use strict';

/**
 * modelCapability — classify a model id into one capability bucket:
 * `text | audio | image | video`.
 *
 * This is an axis ORTHOGONAL to modelTier (T0-T3). Tier answers "how strong is
 * this model"; capability answers "what kind of output does it produce". They
 * are deliberately separate modules so neither overloads the other's caching/env
 * contract — modelTier's docblock is explicitly about the tool-use loop.
 *
 * The catalog graph (modelCatalogGraph.js) is the only caller today: every model
 * edge carries a capability so the "by-capability" view can group text / audio /
 * image / video. Image and video models live OUTSIDE the provider registry (in
 * the KHY_IMAGE_GEN_* / KHY_VIDEO_GEN_* env namespaces); the graph passes a
 * `source` hint for those so they are classified by ORIGIN, not by guessing from
 * the name — the robust, state-transparent path.
 *
 * Resolution order (first match wins):
 *   1. Explicit source hint ('image' | 'video' | 'audio' | 'text') — origin wins.
 *   2. Env override map KHY_MODEL_CAPABILITY_MAP (JSON {"<modelId>":"image"}),
 *      case-insensitive exact match. Lets an operator pin a capability that the
 *      regex would misjudge, with no code change (same spirit as KHY_MODEL_TIER_MAP).
 *   3. Regex heuristics on the model name (image/video/audio tokens).
 *   4. Default 'text' (custom_providers.json models are chat/text by default).
 *
 * Zero-hardcoding: no model/key/url baked in. Only the heuristic regexes are
 * literal, mirroring the WEAK_RE style in modelTier.js.
 */

const VALID_CAPABILITIES = ['text', 'audio', 'image', 'video'];

// Heuristic token regexes (letter-boundary-guarded where a token could match
// inside a larger word). Applied only when no source hint and no env override.
const IMAGE_RE = /(image|vision-gen|dall-?e|sd-?xl|stable-?diffusion|flux|midjourney|imagen|-image-|txt2img|img2img)/i;
const VIDEO_RE = /(video|sora|kling|veo|-video-|txt2video|text-to-video|image-to-video|runway|luma)/i;
const AUDIO_RE = /(audio|whisper|tts|text-to-speech|\bspeech\b|\bvoice\b|realtime|sovits|musicgen)/i;

// Cache the parsed env map keyed by the raw string so repeated calls don't
// re-parse JSON. Mirrors modelTier.js:_resolveModelTierMap.
let _capMapCacheRaw = null;
let _capMapCache = null;

/**
 * Look up a model id in KHY_MODEL_CAPABILITY_MAP (case-insensitive exact match).
 * @param {string} lowerId already-lowercased model id
 * @returns {'text'|'audio'|'image'|'video'|null}
 */
function _resolveCapabilityMap(lowerId) {
  const raw = process.env.KHY_MODEL_CAPABILITY_MAP;
  if (!raw || !String(raw).trim()) { _capMapCacheRaw = null; _capMapCache = null; return null; }
  if (raw !== _capMapCacheRaw) {
    _capMapCacheRaw = raw;
    _capMapCache = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          const cap = String(v || '').trim().toLowerCase();
          if (VALID_CAPABILITIES.includes(cap)) _capMapCache[String(k).toLowerCase()] = cap;
        }
      }
    } catch {
      _capMapCache = {};
    }
  }
  return _capMapCache[lowerId] || null;
}

/**
 * Classify a model id into a capability bucket.
 * @param {string} modelId
 * @param {{source?: string}} [opts] source: 'image'|'video'|'audio'|'text' origin hint
 * @returns {'text'|'audio'|'image'|'video'}
 */
function classifyCapability(modelId, opts = {}) {
  // 1. Source hint wins (origin-based, robust for env-namespace models).
  const source = String(opts.source || '').trim().toLowerCase();
  if (VALID_CAPABILITIES.includes(source)) return source;

  const id = String(modelId || '').toLowerCase();
  if (!id) return 'text';

  // 2. Env override map.
  const mapped = _resolveCapabilityMap(id);
  if (mapped) return mapped;

  // 3. Regex heuristics. Order: video before image (some video names also carry
  //    "image-to-video"); audio last.
  if (VIDEO_RE.test(id)) return 'video';
  if (IMAGE_RE.test(id)) return 'image';
  if (AUDIO_RE.test(id)) return 'audio';

  // 4. Default.
  return 'text';
}

/** Reset the env-map cache (tests only). */
function __resetCacheForTests() {
  _capMapCacheRaw = null;
  _capMapCache = null;
}

module.exports = {
  classifyCapability,
  VALID_CAPABILITIES,
  __resetCacheForTests,
};
