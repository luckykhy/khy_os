'use strict';

/**
 * modelTypeProviderPlan.js — Design: PURE LEAF (纯叶子 / pure-leaf reducer).
 *
 * WHY THIS LEAF EXISTS (deep-dig lens #1 — a missing coherent surface)
 * ------------------------------------------------------------------------
 * Khy resolves a provider SEPARATELY for each user-facing model TYPE, through
 * four DISCONNECTED env namespaces:
 *
 *   - text   (文本): apiKeyPool + providerPresets + gateway pool
 *   - video  (视频): KHY_VIDEO_GEN_* (lives OUTSIDE the provider registry) + pool bridge
 *   - vector (向量): EMBED_URL / ollama / gateway /v1/embeddings
 *   - role   (角色): subAgentModelSelect, reusing the text pool (KHY_SUBAGENT_MODEL_AUTOSELECT)
 *
 * The capability taxonomy (capabilityRegistry.CAPABILITIES, modelCapability
 * .VALID_CAPABILITIES) already NAMES these buckets, but no diagnostic ever
 * reconciles — per TYPE — whether the user actually supplied a reachable API,
 * and whether that API is a RELAY (中转站) or a DIRECT vendor endpoint (直连)
 * or a LOCAL backend. A fresh-machine user who wants to point each type at a
 * different API (relay or direct) has no single coherent answer to:
 *   "which model types are ready, and how is each one wired?"
 *
 * This leaf is that answer. It is a PURE reducer: given already-gathered facts
 * (one entry per type: {baseUrl, hasKey, local, source}) plus the officialHosts
 * allowlist injected from providerPresets (the SSOT — no vendor list is baked
 * in here), it produces a per-type plan {type, configured, channel, status,
 * missing[]} and a rollup. The CLI shell (scripts/model-type-providers.js)
 * does the env/config IO and injects the facts; this file never touches
 * fs/net/process spawning/clock/random and NEVER throws.
 *
 * HONEST BOUNDARIES (核心不变量)
 *   - channel is classified ONLY from the base URL host vs the injected
 *     officialHosts SSOT: loopback → local; host ∈ officialHosts → direct;
 *     any other public host → relay. We do not guess a vendor list here.
 *   - A malformed / non-object facts input degrades to an all-unconfigured plan
 *     — it NEVER throws and NEVER fabricates a "ready" verdict.
 *   - `configured` requires a usable credential path: a key, OR a local backend
 *     (local needs no key). A base URL with no key is `keyless`, not ready.
 */

// ── Canonical user-facing model types (mirrors the capability buckets the
//    gateway already recognizes; role is the orchestrator's per-role model). ──
const CANONICAL_TYPES = ['text', 'video', 'vector', 'role'];

// ── Wiring channel of a resolved endpoint. ──
const CHANNEL_LOCAL = 'local';   // loopback / on-box backend (ollama, localhost)
const CHANNEL_DIRECT = 'direct'; // official vendor host (直连)
const CHANNEL_RELAY = 'relay';   // third-party OpenAI-compatible aggregator (中转站)
const CHANNEL_UNKNOWN = 'unknown'; // key present but no explicit base URL (uses a default)

// ── Per-type readiness status. ──
const STATUS_READY = 'ready';                 // has a usable credential path
const STATUS_KEYLESS = 'keyless';             // endpoint set but no key
const STATUS_UNCONFIGURED = 'unconfigured';   // nothing supplied for this type

function _str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Extract the lowercase host from a base URL string. Fail-soft: returns '' for
 * anything unparseable (never throws). Accepts bare host:port too.
 * @param {string} baseUrl
 * @returns {string} lowercase host without port, or ''
 */
function _hostOf(baseUrl) {
  const s = _str(baseUrl);
  if (!s) return '';
  let host = '';
  try {
    // Prefer the URL parser when a scheme is present.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      host = new URL(s).hostname;
    } else {
      // Bare "host:port/path" — strip path then port.
      host = s.split('/')[0].split(':')[0];
    }
  } catch {
    host = s.split('/')[0].split(':')[0];
  }
  return String(host || '').toLowerCase();
}

/**
 * Is this host a loopback / on-box address?
 * @param {string} host lowercase host
 * @returns {boolean}
 */
function _isLoopback(host) {
  if (!host) return false;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

/**
 * Classify the wiring channel of an endpoint.
 * @param {string} baseUrl
 * @param {string[]} officialHosts lowercase official vendor host suffixes (SSOT-injected)
 * @param {boolean} localHint explicit local flag from the caller (e.g. ollama backend)
 * @returns {'local'|'direct'|'relay'|'unknown'}
 */
function classifyChannel(baseUrl, officialHosts, localHint) {
  const host = _hostOf(baseUrl);
  if (localHint === true || _isLoopback(host)) return CHANNEL_LOCAL;
  if (!host) return CHANNEL_UNKNOWN; // key but no explicit base URL → default host
  const hosts = Array.isArray(officialHosts) ? officialHosts : [];
  for (const raw of hosts) {
    const suffix = _str(raw).toLowerCase();
    if (!suffix) continue;
    if (host === suffix || host.endsWith('.' + suffix) || host.endsWith(suffix)) {
      return CHANNEL_DIRECT;
    }
  }
  return CHANNEL_RELAY;
}

/**
 * Build the plan entry for a single model type.
 * @param {string} type canonical type name
 * @param {object|null} entry {baseUrl, hasKey, local, source} or null/undefined
 * @param {string[]} officialHosts SSOT host allowlist
 * @returns {{type:string, configured:boolean, channel:string, status:string, source:string, baseUrl:string, missing:string[]}}
 */
function _planOne(type, entry, officialHosts) {
  const e = entry && typeof entry === 'object' ? entry : null;
  const baseUrl = e ? _str(e.baseUrl) : '';
  const hasKey = e ? e.hasKey === true : false;
  const local = e ? e.local === true : false;
  const source = e ? _str(e.source) : '';

  const channel = classifyChannel(baseUrl, officialHosts, local);
  const localReady = channel === CHANNEL_LOCAL; // local backend needs no key

  let status;
  let configured;
  const missing = [];

  if (hasKey || localReady) {
    status = STATUS_READY;
    configured = true;
  } else if (baseUrl) {
    // Endpoint pinned but no credential — a relay/direct URL still needs a key.
    status = STATUS_KEYLESS;
    configured = false;
    missing.push('api_key');
  } else {
    status = STATUS_UNCONFIGURED;
    configured = false;
    missing.push('api_key', 'base_url');
  }

  return {
    type,
    configured,
    channel: configured || baseUrl ? channel : CHANNEL_UNKNOWN,
    status,
    source,
    baseUrl,
    missing,
  };
}

/**
 * Produce a per-type provider plan across the four canonical model types.
 *
 * @param {object} facts
 * @param {object} [facts.types] map of type → {baseUrl, hasKey, local, source}
 * @param {string[]} [facts.officialHosts] official vendor host suffixes (SSOT-injected)
 * @returns {{
 *   ok: boolean,
 *   types: Array<object>,
 *   configuredCount: number,
 *   unconfiguredTypes: string[],
 *   byChannel: {local:number, direct:number, relay:number, unknown:number},
 *   summary: string
 * }}
 */
function planModelTypeProviders(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const typeFacts = f.types && typeof f.types === 'object' ? f.types : {};
  const officialHosts = Array.isArray(f.officialHosts) ? f.officialHosts : [];

  const types = CANONICAL_TYPES.map((t) => _planOne(t, typeFacts[t], officialHosts));

  const byChannel = { local: 0, direct: 0, relay: 0, unknown: 0 };
  const unconfiguredTypes = [];
  let configuredCount = 0;
  for (const entry of types) {
    if (entry.configured) {
      configuredCount++;
      if (byChannel[entry.channel] !== undefined) byChannel[entry.channel]++;
    } else {
      unconfiguredTypes.push(entry.type);
    }
  }

  const ok = configuredCount === CANONICAL_TYPES.length;
  const summary = ok
    ? `全部 ${CANONICAL_TYPES.length} 类模型均已配置可用 provider`
    : `${configuredCount}/${CANONICAL_TYPES.length} 类已配置；未配置：${unconfiguredTypes.join('、') || '无'}`;

  return { ok, types, configuredCount, unconfiguredTypes, byChannel, summary };
}

module.exports = {
  planModelTypeProviders,
  classifyChannel,
  CANONICAL_TYPES,
  CHANNEL_LOCAL,
  CHANNEL_DIRECT,
  CHANNEL_RELAY,
  CHANNEL_UNKNOWN,
  STATUS_READY,
  STATUS_KEYLESS,
  STATUS_UNCONFIGURED,
  _hostOf,
  _isLoopback,
};
