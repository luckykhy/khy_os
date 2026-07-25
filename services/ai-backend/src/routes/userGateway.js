/**
 * User-domain gateway routes (multi-tenant — Stage 2).
 *
 * Mounts at /api/user-gateway with `authenticateToken` only — NO
 * requireAdmin. Every handler is scoped to `req.user.id`, so a user can only
 * read/write their own relay config, custom providers, and CC tokens. This is
 * a deliberate clone of the admin gateway surface; the admin router
 * (`aiGatewayAdmin.js`, locked by requireAdmin) is left untouched and keeps
 * owning all global `.env` / global-pool mutation.
 *
 * Storage goes through `userGatewayConfigService` (per-user DB tables, never
 * process.env). CC tokens reuse the shared `ApiKey` model rather than a
 * separate token system. Each write evicts the per-user resolver cache so the
 * data plane (Stage 3) picks up changes immediately.
 *
 * @pattern Proxy
 */
'use strict';

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const { ApiKey } = require('@khy/shared/models');
const { generateKey, hashApiKey, extractPrefix } = require('@khy/shared/utils/apiKeyHash');

const svc = require('../services/userGatewayConfigService');
const proxyServer = require('../services/gateway/proxyServer');
const { invalidateUser } = require('../services/gateway/userGatewayResolver');
const userModelCatalogGraph = require('../services/gateway/userModelCatalogGraph');
const userModelDetectionService = require('../services/gateway/userModelDetectionService');
// Built-in common-provider presets (single source, key-less, env-extensible).
const { getProviderPresets } = require('../../../backend/src/services/gateway/providerPresets');

// All routes require a logged-in user (JWT or API key). No admin gate.
router.use(authenticateToken);

// 收敛到 utils/reqUserId 单一真源(逐字节委托,调用点不变)
const userId = require('../utils/reqUserId');

function fail(res, err) {
  const code = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = (err && err.message) || 'Internal server error';
  if (code >= 500) console.error('[user-gateway]', err);
  res.status(code).json({ success: false, message });
}

/**
 * Best-effort post-save detection: probe one upstream's /v1/models and persist.
 * Always resolves (never rejects) so a probe failure can NEVER block the save it
 * follows; the outcome is returned for state transparency only.
 */
async function detectSafely(uid, provider) {
  try {
    return await userModelDetectionService.detectForProvider(uid, provider);
  } catch (err) {
    return { provider, probed: false, added: 0, total: 0, error: (err && err.message) || 'detection failed' };
  }
}

// ── Relay config (per-user upstream) ───────────────────────────────────────

// GET /api/user-gateway/model-config — current effective relay (source flag)
router.get('/model-config', async (req, res) => {
  try {
    const data = await svc.getRelayConfig(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/user-gateway/model-config — upsert relay; never touches global .env
router.put('/model-config', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.saveRelayConfig(uid, req.body || {});
    invalidateUser(uid);
    // Best-effort auto-detect on save: probe the relay's /v1/models and persist.
    // Failure NEVER blocks the save — it only annotates the response.
    const detection = await detectSafely(uid, 'relay');
    res.json({ success: true, data, detection });
  } catch (err) {
    fail(res, err);
  }
});

// ── Image-generation model preference (per-user) ───────────────────────────

// GET /api/user-gateway/image-config — current preferred image backend/model.
router.get('/image-config', async (req, res) => {
  try {
    const data = await svc.getImagePref(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/user-gateway/image-config — upsert preferred image backend/model.
// backend empty or 'auto' clears the pin (engine falls back to global/auto).
router.put('/image-config', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.saveImagePref(uid, req.body || {});
    invalidateUser(uid);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// ── Unified multi-pivot catalog (per-user) ─────────────────────────────────

// GET /api/user-gateway/catalog — flat edge list for the by-* views. Scoped to
// req.user.id; keys masked (only opaque ids surface). Pivoting happens client
// side via the shared useModelPivots composable, identical to the global plane.
router.get('/catalog', async (req, res) => {
  try {
    const data = await userModelCatalogGraph.buildCatalogGraph(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/user-gateway/detect — manual "检测/刷新": run a fresh upstream probe
// + persist sweep across the user's own upstreams, then return the enriched
// catalog (own models filled, Ollama/system live-merged, keys masked). The
// `sources` block reports what each detector saw (counts + per-upstream errors).
router.post('/detect', async (req, res) => {
  try {
    const data = await userModelCatalogGraph.buildCatalogGraph(userId(req), { detect: true });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// ── My model list (per-user persisted models — full CRUD) ──────────────────
// These manage user_provider_models directly: the user's own catalog of models
// (detected from their upstreams OR added by hand). Read/add/edit/remove, all
// scoped to req.user.id. The live catalog (GET /catalog) still merges these with
// local Ollama + system metadata; this surface is the editable source of truth
// for the user's OWN models only.

// GET /api/user-gateway/models[?provider=] — list this user's persisted models
router.get('/models', async (req, res) => {
  try {
    const provider = req.query && req.query.provider ? String(req.query.provider) : undefined;
    const data = await svc.listModels(userId(req), provider ? { provider } : {});
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/user-gateway/models — manually add one model (409 on duplicate)
router.post('/models', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.addModel(uid, req.body || {});
    invalidateUser(uid);
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/user-gateway/models/:id — edit capability / active / rename (404/409)
router.patch('/models/:id', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.updateModel(uid, req.params.id, req.body || {});
    invalidateUser(uid);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/user-gateway/models/:id — remove one model from the user's list
router.delete('/models/:id', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.removeModel(uid, req.params.id);
    invalidateUser(uid);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/user-gateway/provider-presets — built-in common providers so the
// relay + custom-provider forms can offer a "pick a provider" dropdown that
// auto-fills baseUrl/apiFormat/defaultModel. Returns key-less metadata only;
// the user always supplies their own credential. Extendable via env
// KHY_PROVIDER_PRESETS without a code change.
router.get('/provider-presets', (req, res) => {
  try {
    res.json({ success: true, data: getProviderPresets() });
  } catch (err) {
    fail(res, err);
  }
});

// ── Custom providers + key pool (per-user) ─────────────────────────────────

// GET /api/user-gateway/custom-providers — list this user's provider entries
router.get('/custom-providers', async (req, res) => {
  try {
    const data = await svc.listProviders(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/user-gateway/custom-providers — add a provider+key entry (409 dup)
router.post('/custom-providers', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.addProviderEntry(uid, req.body || {});
    invalidateUser(uid);
    // Best-effort auto-detect on add: probe this provider's /v1/models and persist.
    const detection = await detectSafely(uid, data.provider);
    res.status(201).json({ success: true, data, detection });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/user-gateway/custom-providers/:id — edit one entry. A bare { key }
// rotates the key (legacy contract); a richer patch may also change
// displayName / baseUrl / apiFormat / endpoint and even RENAME the provider
// (models migrate with it). Re-probes the resulting upstream for transparency.
router.put('/custom-providers/:id', async (req, res) => {
  try {
    const uid = userId(req);
    const data = await svc.updateProviderEntry(uid, req.params.id, req.body || {});
    invalidateUser(uid);
    const detection = await detectSafely(uid, data.provider);
    res.json({ success: true, data, detection });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/user-gateway/providers/test — DRY-RUN "测试连接": probe the given
// upstream config (baseUrl/endpoint + key + apiFormat) and report reachability +
// discovered models WITHOUT persisting anything. Lets the config dialog verify a
// key and offer one-click model import before the user commits.
router.post('/providers/test', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await userModelDetectionService.probeConfig({
      baseUrl: b.baseUrl,
      endpoint: b.endpoint,
      apiKey: b.apiKey || b.key,
      apiFormat: b.apiFormat,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/user-gateway/custom-providers/:id — remove a single key entry
router.delete('/custom-providers/:id', async (req, res) => {
  try {
    const data = await svc.removeProviderEntry(userId(req), req.params.id);
    invalidateUser(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/user-gateway/providers/by-name/:provider — remove all entries
router.delete('/providers/by-name/:provider', async (req, res) => {
  try {
    const data = await svc.removeProvider(userId(req), req.params.provider);
    invalidateUser(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// ── CC access (unified proxy endpoint + channel tokens) ────────────────────

function mapKeyRow(row) {
  return {
    id: row.id,
    keyPrefix: row.keyPrefix || '',
    label: row.label || 'default',
    isActive: !!row.isActive,
    lastUsedAt: row.lastUsedAt || null,
    createdAt: row.createdAt || null,
  };
}

// GET /api/user-gateway/cc/endpoint — unified proxy endpoint + usage hint
router.get('/cc/endpoint', (req, res) => {
  try {
    const port = proxyServer.getPort();
    const publicUrl = String(process.env.PROXY_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    const host = String(req.headers['x-forwarded-host'] || req.hostname || 'localhost').split(':')[0];
    const endpoint = publicUrl || `http://${host}:${port}`;
    res.json({
      success: true,
      data: {
        endpoint,
        port,
        usage: {
          anthropicBaseUrl: endpoint,
          authToken: '<your CC token from POST /cc/tokens>',
          hint: 'Set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN to point Claude Code at this endpoint.',
        },
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/user-gateway/cc/tokens — list this user's tokens (metadata only)
router.get('/cc/tokens', async (req, res) => {
  try {
    const rows = await ApiKey.findAll({
      where: { userId: userId(req) },
      order: [['id', 'DESC']],
    });
    res.json({ success: true, data: rows.map(mapKeyRow) });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/user-gateway/cc/tokens — issue a CC token (rotates the active one)
router.post('/cc/tokens', async (req, res) => {
  try {
    const uid = userId(req);
    const label = String((req.body && req.body.label) || 'default').trim() || 'default';

    // Single-active-key model (mirrors apiKey.js): revoke prior active keys.
    await ApiKey.update({ isActive: false }, { where: { userId: uid, isActive: true } });

    const rawKey = generateKey();
    const row = await ApiKey.create({
      userId: uid,
      keyHash: hashApiKey(rawKey),
      keyPrefix: extractPrefix(rawKey),
      label,
      isActive: true,
    });
    invalidateUser(uid);

    res.status(201).json({
      success: true,
      message: 'CC token issued — copy it now, it will not be shown in full again',
      data: { ...mapKeyRow(row), key: rawKey }, // full key only on creation
    });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/user-gateway/cc/tokens/:id — revoke one of this user's tokens
router.delete('/cc/tokens/:id', async (req, res) => {
  try {
    const uid = userId(req);
    const id = Number(req.params.id);
    const [updated] = await ApiKey.update(
      { isActive: false },
      { where: { userId: uid, id } }
    );
    invalidateUser(uid);
    res.json({ success: true, data: { revoked: updated > 0, id } });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
