/**
 * Per-user gateway resolver (multi-tenant data plane seam — Stage 0).
 *
 * Single interface the data plane (Stage 3) will use to map an inbound CC
 * `Authorization: Bearer khy_...` token to its owner's per-user upstream.
 * Until Stage 3 wires it into `dataPlaneEnforcer`, this module is lazy
 * dead code — it is only invoked by route writes to invalidate the cache,
 * so creating it now is zero-regression.
 *
 * The token is a shared `ApiKey` (khy_) — we deliberately reuse it as the
 * token→user mapping instead of inventing a separate token system.
 *
 * @pattern Strategy
 */
'use strict';

const { ApiKey, User } = require('@khy/shared/models');
const { hashApiKey } = require('@khy/shared/utils/apiKeyHash');
const svc = require('../userGatewayConfigService');

// Short TTL guards the hot path without holding stale per-user upstreams for
// long; same-process writes call invalidateUser() for instant correctness,
// and the TTL bounds cross-process staleness (the trading backend may rotate
// ApiKeys independently).
const TTL_MS = 30 * 1000;

// keyHash -> { expiresAt, userId, value }
//   userId : owner id when the token matched an active ApiKey, else null.
//            Tracked even when `value` is null (no usable relay) so a later
//            saveRelayConfig → invalidateUser(userId) can evict this entry.
//   value  : { userId, relay, providers } to return, or null on miss / no relay.
const _cache = new Map();

/**
 * Resolve a CC bearer token to its owner's per-user gateway context.
 *
 * Returns `{ userId, relay, providers }` whenever the token maps to an active
 * ApiKey row — `relay` is the resolved upstream or `null` when the user has
 * not configured one. Returns `null` only when the token matches no active
 * ApiKey. Surfacing the matched user even without a relay lets the data plane
 * distinguish "known user, not configured" (→ fall back, or reject under strict
 * isolation) from "unknown token" (→ existing ladder), and lets a later
 * config save invalidate the cached entry by userId.
 *
 * @param {string} token raw bearer token (khy_...)
 * @returns {Promise<{userId:number, relay:object|null, providers:object[]}|null>}
 */
async function resolveUserGatewayContext(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;

  const keyHash = hashApiKey(raw);
  const cached = _cache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let userId = null;
  let value = null;
  try {
    const record = await ApiKey.findOne({
      where: { keyHash, isActive: true },
      include: [{ model: User, as: 'user' }],
    });
    if (record && record.userId) {
      userId = record.userId;
      const relay = await svc.getResolvedRelay(userId); // null when unconfigured
      const providers = relay ? await svc.getResolvedProviders(userId) : [];
      value = { userId, relay, providers };
    }
  } catch {
    // On any DB error, behave as a miss — never block the data plane.
    userId = null;
    value = null;
  }

  _cache.set(keyHash, { expiresAt: Date.now() + TTL_MS, userId, value });
  return value;
}

/**
 * Evict every cached entry owned by `userId`. Called after a per-user
 * config/provider/token write so the next resolve re-reads fresh state.
 * @param {number} userId
 */
function invalidateUser(userId) {
  const uid = Number(userId);
  if (!Number.isFinite(uid)) return;
  for (const [keyHash, entry] of _cache) {
    if (entry && Number(entry.userId) === uid) {
      _cache.delete(keyHash);
    }
  }
}

/** Drop the entire cache (tests / shutdown). */
function invalidateAll() {
  _cache.clear();
}

module.exports = { resolveUserGatewayContext, invalidateUser, invalidateAll };
