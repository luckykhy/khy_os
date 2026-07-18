/**
 * userModelDetectionService — orchestrates "detect models for a user's own
 * upstreams and persist them" for the per-user (multi-tenant) catalog.
 *
 * Scope (deliberately narrow): this service ONLY probes the user's OWN
 * configured upstreams (the relay + each UserProvider key) via their advertised
 * `/v1/models` endpoint and persists what comes back into `user_provider_models`
 * (through userGatewayConfigService.upsertModels). It is the "auto-add on
 * detection" half of the feature; manual add already exists.
 *
 * What it does NOT do:
 *   - It never touches the global/admin plane or process.env.
 *   - It never copies admin/env plaintext keys into a user's store.
 *   - Local Ollama + system/global metadata are LIVE-merged at read time by
 *     userModelCatalogGraph, NOT persisted here (tenant isolation + freshness).
 *
 * Never-throw at the per-probe level: a failed probe degrades to
 * `{ probed:true, error }` so one dead upstream can't abort the whole sweep or
 * block a config save. Decrypted keys are used server-side only and never
 * returned. Capability is classified by the shared modelCapability classifier so
 * image/video models are labelled correctly (they still only ever land in the
 * catalog — never in any proxy route table).
 *
 * @pattern Strategy
 */
'use strict';

const svc = require('../userGatewayConfigService');
// Single-source upstream probe + capability classifier, imported from the
// backend package (pure, dependency-free) — not duplicated.
const { fetchUpstreamModels } = require('../../../../backend/src/services/gateway/upstreamModelProbe');
const modelCapability = require('../../../../backend/src/services/gateway/modelCapability');

const RELAY_PROVIDER = 'relay';

/** Map probed model ids → upsert items with a classified capability. */
function toItems(models) {
  return (Array.isArray(models) ? models : [])
    .filter((m) => m && m.id)
    .map((m) => ({ model: m.id, capability: modelCapability.classifyCapability(m.id) }));
}

/**
 * Probe ONE of the user's upstreams (`relay` or a named provider) and persist
 * any models it advertises. Used both by the post-save narrow hook and the full
 * sweep. Never throws.
 *
 * @returns {Promise<{provider:string, probed:boolean, added:number, total:number, error:(string|null)}>}
 */
async function detectForProvider(userId, provider) {
  const p = String(provider || '').trim().toLowerCase();
  if (!p) return { provider: '', probed: false, added: 0, total: 0, error: 'provider is required' };

  try {
    let probeArgs = null;

    if (p === RELAY_PROVIDER) {
      const relay = await svc.getResolvedRelay(userId);
      if (relay && relay.baseUrl && relay.apiKey) {
        probeArgs = {
          baseUrl: relay.baseUrl,
          endpoint: Array.isArray(relay.endpoints) && relay.endpoints[0] ? relay.endpoints[0] : '',
          apiKey: relay.apiKey,
          apiFormat: relay.apiFormat,
        };
      }
    } else {
      const resolved = await svc.getResolvedProviders(userId);
      const matches = resolved.filter((r) => r.provider === p);
      // Use the highest-priority entry (already ordered DESC) that can be probed.
      const entry = matches.find((r) => (r.baseUrl || r.endpoint) && r.key);
      if (entry) {
        probeArgs = {
          baseUrl: entry.baseUrl,
          endpoint: entry.endpoint,
          apiKey: entry.key,
          apiFormat: entry.apiFormat,
        };
      }
    }

    // No usable upstream (no key / no base url) → nothing to probe, not an error.
    if (!probeArgs) return { provider: p, probed: false, added: 0, total: 0, error: null };

    const models = await fetchUpstreamModels(probeArgs);
    if (models == null) {
      // Probe attempted but returned nothing — the upstream has no /models
      // endpoint (e.g. anthropic) or answered 4xx. This is an EXPECTED, benign
      // outcome, not a real failure: many providers simply don't advertise a
      // catalog. Flag it `benign` so the UI can stay quiet instead of flashing a
      // scary "not found" / probe-failed error on every detect.
      return { provider: p, probed: true, added: 0, total: 0, error: 'upstream /models probe failed', benign: true };
    }

    const { added, total } = await svc.upsertModels(userId, p, toItems(models), { source: 'detected' });
    return { provider: p, probed: true, added, total, error: null, benign: false };
  } catch (err) {
    // A thrown error (DNS, TLS, server fault) is a REAL problem worth surfacing.
    return { provider: p, probed: true, added: 0, total: 0, error: (err && err.message) || 'detection failed', benign: false };
  }
}

/**
 * Sweep ALL of the user's own upstreams (relay + every distinct provider in the
 * key pool), probing + persisting each. Returns an aggregate summary for state
 * transparency. Never throws.
 *
 * @returns {Promise<{providers:Array, added:number, total:number, probed:number, errors:Array}>}
 */
async function detectUpstreams(userId) {
  const names = new Set([RELAY_PROVIDER]);
  const errors = [];

  try {
    const resolved = await svc.getResolvedProviders(userId);
    for (const r of resolved) {
      if (r && r.provider) names.add(String(r.provider).trim().toLowerCase());
    }
  } catch (err) {
    errors.push({ source: 'providers', error: (err && err.message) || 'list providers failed' });
  }

  const providers = [];
  let added = 0;
  let total = 0;
  let probed = 0;
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const res = await detectForProvider(userId, name);
    providers.push(res);
    if (res.probed) probed += 1;
    added += res.added || 0;
    total += res.total || 0;
    if (res.error) errors.push({ source: 'upstream', provider: name, error: res.error, benign: !!res.benign });
  }

  return { providers, added, total, probed, errors };
}

/**
 * DRY-RUN probe of an arbitrary upstream config — "测试连接" before saving.
 * Probes the given {baseUrl/endpoint, apiKey, apiFormat} via the shared
 * /v1/models probe and reports what it found WITHOUT persisting anything. The
 * caller (the config dialog) uses this to verify a key + surface the discovered
 * models for one-click import. Never throws.
 *
 * @returns {Promise<{ok:boolean, count:number, models:Array<{id:string, capability:string}>, error:(string|null)}>}
 */
async function probeConfig(args = {}) {
  const baseUrl = String(args.baseUrl || '').trim();
  const endpoint = String(args.endpoint || '').trim();
  const apiKey = String(args.apiKey || args.key || '').trim();
  if (!apiKey) return { ok: false, count: 0, models: [], error: 'API Key 不能为空' };
  if (!baseUrl && !endpoint) return { ok: false, count: 0, models: [], error: '缺少 Base URL / Endpoint，无法探测' };

  try {
    const models = await fetchUpstreamModels({ baseUrl, endpoint, apiKey, apiFormat: args.apiFormat });
    if (models == null) {
      // No /models endpoint or a 4xx — expected for some providers; report it
      // as a soft "could not list" rather than a hard error so the UI stays calm.
      return { ok: false, count: 0, models: [], error: '该上游未返回模型列表（可能无 /models 接口或鉴权失败），可手动填写模型' };
    }
    const items = toItems(models).map((m) => ({ id: m.model, capability: m.capability }));
    return { ok: true, count: items.length, models: items, error: null };
  } catch (err) {
    return { ok: false, count: 0, models: [], error: (err && err.message) || '探测失败' };
  }
}

module.exports = {
  detectForProvider,
  detectUpstreams,
  probeConfig,
  // test hooks
  __testHooks: { toItems },
};
