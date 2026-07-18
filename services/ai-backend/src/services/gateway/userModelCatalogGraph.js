/**
 * userModelCatalogGraph — the per-user (multi-tenant) twin of the global
 * modelCatalogGraph. It produces the SAME flat "edge" shape so the Web layer can
 * reuse the one client-side pivot module (apps/ai-frontend useModelPivots.js) for
 * both /api/ai-gateway/catalog (global) and /api/user-gateway/catalog (per-user).
 *
 * Data-model reality: a user has at most one relay upstream (UserGatewayConfig —
 * one configured model id) plus a key pool of UserProvider rows (provider + key
 * + baseUrl, NO models). To make the catalog actually populate, four sources are
 * joined here:
 *   1. RELAY/PROVIDER own models  — the configured relay model PLUS any models
 *      DETECTED from the user's own upstreams (`/v1/models`) and PERSISTED in
 *      user_provider_models. source:'relay' | 'provider'.
 *   2. LOCAL models               — a live probe of a locally running Ollama;
 *      live-merged, never stored. source:'local'.
 *   3. SYSTEM/global models       — METADATA ONLY from the global catalog graph
 *      (registry + pool + env). No key material crosses into the user plane; a
 *      model the system can serve shows status 'system-ready', otherwise
 *      'needs-key'. source:'system'.
 *
 * The `detect` option additionally runs a fresh upstream probe-and-persist sweep
 * (userModelDetectionService) before building, so "检测/刷新" pulls new models in.
 * Without it the build is read-only + live-merge (fast, deterministic): the
 * persisted own models always show, Ollama/system appear/disappear with reality.
 *
 * Zero-fabrication + state transparency: a model only appears if it was probed,
 * configured, manually added, or is offered by the system; `sources` reports
 * exactly what each detector saw (including per-upstream probe errors). Capability
 * is the shared classifier's verdict (image/video labelled correctly — they only
 * ever land in the catalog, never in any proxy route table). Keys are NEVER
 * returned: own edges expose only opaque key ids, system edges expose none.
 *
 * Edge shape (mirrors backend modelCatalogGraph):
 *   { provider, providerLabel, model, keyIds[], keyCount, capability, tier,
 *     status, connectionMode, isDefault, source }
 */
'use strict';

const svc = require('../userGatewayConfigService');
const detectionService = require('./userModelDetectionService');
// Pure, dependency-free classifiers + probes shared with the global graph
// (imported from the backend package, not copied).
const modelCapability = require('../../../../backend/src/services/gateway/modelCapability');
const modelTier = require('../../../../backend/src/services/modelTier');
const globalCatalogGraph = require('../../../../backend/src/services/gateway/modelCatalogGraph');
const { fetchLocalModels } = require('../../../../backend/src/services/gateway/localOllamaProbe');

/** Derive a readable provider label for the relay upstream from its base URL. */
function _relayLabel(baseUrl) {
  const u = String(baseUrl || '').trim();
  if (!u) return 'relay 上游';
  try {
    return new URL(u).host || 'relay 上游';
  } catch {
    return 'relay 上游';
  }
}

/**
 * Build the per-user catalog graph.
 *
 * @param {number} userId scoped owner id (already authenticated upstream).
 * @param {{detect?: boolean}} [opts] detect=true runs a fresh upstream probe +
 *   persist sweep before building (the "检测/刷新" path).
 * @returns {Promise<{edges:Array, generatedAt:number, sources:object}>}
 */
async function buildCatalogGraph(userId, opts = {}) {
  const detect = Boolean(opts.detect);
  const edges = [];
  const errors = [];
  const sources = {
    relay: 0,
    providers: 0,
    ownModels: 0,
    local: { running: false, count: 0 },
    system: { count: 0 },
    live: detect,
    detectedAt: null,
  };

  // ── 0. Optional fresh detection (probe own upstreams + persist) ──
  if (detect) {
    try {
      const summary = await detectionService.detectUpstreams(userId);
      sources.detectedAt = Date.now();
      sources.upstream = { probed: summary.probed, added: summary.added, total: summary.total };
      for (const e of summary.errors || []) errors.push(e);
    } catch (err) {
      errors.push({ source: 'detect', error: (err && err.message) || 'detection failed' });
    }
  }

  // Persisted own models, grouped by provider id ('relay' or a provider name).
  const ownByProvider = new Map();
  try {
    const models = await svc.listModels(userId);
    sources.ownModels = models.length;
    for (const m of models) {
      if (!ownByProvider.has(m.provider)) ownByProvider.set(m.provider, []);
      ownByProvider.get(m.provider).push(m);
    }
  } catch (err) {
    errors.push({ source: 'ownModels', error: (err && err.message) || 'list models failed' });
  }

  // Track (provider::model) already emitted so system metadata never duplicates
  // a model the user already owns locally.
  const seen = new Set();
  const mark = (provider, model) => seen.add(`${provider}::${String(model || '').toLowerCase()}`);
  const has = (provider, model) => seen.has(`${provider}::${String(model || '').toLowerCase()}`);

  // ── 1. Relay upstream: configured model + any detected/persisted relay models ──
  try {
    const relay = await svc.getRelayConfig(userId); // masked snapshot + source flag
    if (relay && relay.source === 'user' && relay.baseUrl) {
      const label = _relayLabel(relay.baseUrl);
      const keyIds = relay.hasApiKey ? ['relay'] : [];
      const defaultModel = relay.modelId || '';
      const relayModels = new Map(); // model -> capability
      if (defaultModel) relayModels.set(defaultModel, modelCapability.classifyCapability(defaultModel));
      for (const m of (ownByProvider.get('relay') || [])) {
        if (!relayModels.has(m.model)) relayModels.set(m.model, m.capability || modelCapability.classifyCapability(m.model));
      }
      for (const [model, capability] of relayModels) {
        edges.push({
          provider: 'relay',
          providerLabel: label,
          model,
          keyIds,
          keyCount: keyIds.length,
          capability,
          tier: modelTier.resolveTier(model),
          status: relay.hasApiKey ? 'active' : 'needs-key',
          connectionMode: 'proxy',
          isDefault: model === defaultModel,
          source: 'relay',
        });
        mark('relay', model);
        sources.relay += 1;
      }
    }
  } catch (err) {
    errors.push({ source: 'relay', error: (err && err.message) || 'relay read failed' });
  }

  // ── 2. Per-user provider key pool: one edge per (provider, detected model), or
  //       a placeholder edge when nothing has been detected yet. ──
  try {
    const providers = await svc.listProviders(userId); // masked rows
    // Aggregate key ids per provider name (pivots group by provider/key).
    const byName = new Map();
    for (const p of providers) {
      if (!byName.has(p.provider)) {
        byName.set(p.provider, { label: p.displayName || p.provider, keyIds: [], anyActive: false });
      }
      const g = byName.get(p.provider);
      g.keyIds.push(String(p.id));
      if (p.isActive) g.anyActive = true;
    }
    for (const [name, g] of byName) {
      const ownModels = ownByProvider.get(name) || [];
      const status = g.anyActive ? 'active' : 'disabled';
      if (ownModels.length === 0) {
        // No model discovered yet — keep the provider visible (model '' renders as
        // "—"); it still groups in by-provider / by-key / by-status / by-connection.
        edges.push({
          provider: name,
          providerLabel: g.label,
          model: '',
          keyIds: g.keyIds,
          keyCount: g.keyIds.length,
          capability: 'text',
          tier: modelTier.resolveTier(''),
          status,
          connectionMode: 'direct',
          isDefault: false,
          source: 'provider',
        });
      } else {
        for (const m of ownModels) {
          edges.push({
            provider: name,
            providerLabel: g.label,
            model: m.model,
            keyIds: g.keyIds,
            keyCount: g.keyIds.length,
            capability: m.capability || modelCapability.classifyCapability(m.model),
            tier: modelTier.resolveTier(m.model),
            status,
            connectionMode: 'direct',
            isDefault: false,
            source: 'provider',
          });
          mark(name, m.model);
        }
      }
      sources.providers += 1;
    }
  } catch (err) {
    errors.push({ source: 'providers', error: (err && err.message) || 'providers read failed' });
  }

  // ── 3. Local model server (Ollama) — live, never persisted ──
  try {
    const local = await fetchLocalModels();
    sources.local = { running: !!local.running, count: (local.models || []).length };
    if (local.error) errors.push({ source: 'local', error: local.error });
    for (const m of (local.models || [])) {
      if (has('local', m.id)) continue;
      edges.push({
        provider: 'local',
        providerLabel: '本地 Ollama',
        model: m.id,
        keyIds: [],
        keyCount: 0,
        capability: modelCapability.classifyCapability(m.id),
        tier: modelTier.resolveTier(m.id),
        status: 'active', // it answered /api/tags → it's serving
        connectionMode: 'direct',
        isDefault: false,
        source: 'local',
      });
      mark('local', m.id);
    }
  } catch (err) {
    errors.push({ source: 'local', error: (err && err.message) || 'local probe failed' });
  }

  // ── 4. System / global plane — METADATA ONLY (tenant isolation: no keys) ──
  try {
    const global = await globalCatalogGraph.buildCatalogGraph({ live: false });
    let count = 0;
    for (const e of (global.edges || [])) {
      // Never leak global key ids/material into a user's plane. Surface only the
      // fact that the system can (or cannot) serve this model.
      if (has(e.provider, e.model)) continue;
      // Faithful status (state transparency): only call it "needs-key" (待配 Key)
      // when the system genuinely has NO key for this provider. When a key DOES
      // exist but is temporarily failing/cooling, say so honestly instead of
      // claiming "no key" — otherwise a user who already configured a key (env,
      // global pool, or the shipped trial key) is wrongly told it is missing.
      // We read only the COUNT, never the key ids, so tenant isolation holds
      // (the user-facing edge still carries keyIds:[]/keyCount:0).
      const sysHasKey = (e.keyCount || (Array.isArray(e.keyIds) ? e.keyIds.length : 0)) > 0;
      let sysStatus;
      if (e.status === 'active') sysStatus = 'system-ready';
      else if (!sysHasKey) sysStatus = 'needs-key';
      else if (e.status === 'cooldown') sysStatus = 'system-cooldown';
      else sysStatus = 'system-error';
      edges.push({
        provider: e.provider,
        providerLabel: e.providerLabel,
        model: e.model,
        keyIds: [],
        keyCount: 0,
        capability: e.capability,
        tier: e.tier,
        status: sysStatus,
        connectionMode: 'system',
        isDefault: false,
        source: 'system',
      });
      mark(e.provider, e.model);
      count += 1;
    }
    sources.system = { count };
  } catch (err) {
    errors.push({ source: 'system', error: (err && err.message) || 'system catalog failed' });
  }

  sources.errors = errors;
  return { edges, generatedAt: Date.now(), sources };
}

module.exports = {
  buildCatalogGraph,
  // test hook
  __testHooks: { _relayLabel },
};
