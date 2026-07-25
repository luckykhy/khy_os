'use strict';

/**
 * imageGenUserPref — read a user's preferred image-generation backend/model.
 *
 * The per-user analogue of the global KHY_IMAGE_GEN_* env config. The web layer
 * (services/ai-backend) persists this onto UserGatewayConfig.{imageBackend,imageModel}
 * via /api/user-gateway/image-config; the engine reads it here by userId when the
 * tool loop carries identity (see tools/imageGenerate.js).
 *
 * Fully fail-soft: any error (no userId, missing table/columns on an old DB,
 * driver issue) returns null so image generation falls back to the global
 * env/auto path — image selection must never break generation itself.
 */

const VALID_BACKENDS = new Set(['openai', 'agnes', 'domestic', 'sd_webui']);

/**
 * @param {number|string} userId
 * @returns {Promise<{backend:string, model:string}|null>} override, or null when
 *          the user has no pin (auto) or anything goes wrong.
 */
async function getUserImagePref(userId) {
  if (userId == null || userId === '') return null;
  try {
    const { UserGatewayConfig } = require('@khy/shared/models');
    if (!UserGatewayConfig || typeof UserGatewayConfig.findOne !== 'function') return null;
    const row = await UserGatewayConfig.findOne({ where: { userId } });
    if (!row) return null;
    const backend = String(row.imageBackend || '').trim().toLowerCase();
    if (!backend || backend === 'auto' || !VALID_BACKENDS.has(backend)) return null;
    const model = String(row.imageModel || '').trim();
    return { backend, model };
  } catch {
    return null;
  }
}

module.exports = { getUserImagePref };
